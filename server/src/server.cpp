// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// daylight_server: the daylight CLI over HTTP for several users at once, core linked in-process (OptiX needs the GPU
// box, so no WASM). One worker thread owns the GPU and runs queued jobs one after another; everything else (uploads,
// validation, cached answers, status polls, weather downloads) runs on the HTTP thread pool and never waits for it.
// The API is self-describing: GET /openapi.json (OpenAPI 3.1, embedded from server/openapi.json), /docs (Swagger UI),
// /redoc (ReDoc) and /llms.txt (a plain-text guide for agents). With --mcp, agents on this machine drive the web app
// over MCP (POST /mcp): each tool call is relayed to the app's browser tab, or to a hidden instance the server starts;
// the app keeps its reports here and has a headless browser print them to PDF.
#include "cli.h"
#include "daylight.h"
#include <httplib.h>
#include <cuda_runtime.h>
#include <windows.h>

#include "agent.h"
#include "llms_txt.h"
#include "mcp_json.h"
#include "openapi_json.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <list>
#include <memory>
#include <mutex>
#include <process.h>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;
using namespace daylight;
using Clock = std::chrono::steady_clock;

namespace {

// ---------------------------------------------------------------------------------------------------- state
struct MeshEntry { std::shared_ptr<const Mesh> mesh; size_t bytes = 0; uint64_t used = 0; };

enum class State { Queued, Running, Done, Error, Cancelled };
const char* name(State s) { static const char* n[] = {"queued", "running", "done", "error", "cancelled"}; return n[int(s)]; }
bool finished(State s) { return s == State::Done || s == State::Error || s == State::Cancelled; }

struct Job {
  std::string id, client, key;                    // key: the request identity for the response cache
  // inputs, immutable once queued
  cli::Args args;
  Weather weather;
  bool haveWeather = false;
  std::string weatherCache;                       // hit | miss | none (the cache report)
  std::vector<std::pair<std::shared_ptr<const Mesh>, bool>> meshes;   // mesh, sensor
  std::string sceneKey;
  std::atomic<bool> cancel{false};
  // outputs and state, guarded by Server::jobsMu
  State state = State::Queued;
  std::time_t created = 0, started = 0, ended = 0;
  std::shared_ptr<const std::string> body;        // done: the result JSON (the same text POST /run answers)
  std::string error;                              // error / cancelled: the message
  int status = 0;                                 // error: the HTTP status POST /run answers
};

// Agent routes (--mcp), guarded by Server::mcpMu: a tools/call relayed to an app tab (POST /mcp -> GET /bridge/next ->
// POST /bridge/result/{id}), and the tabs that poll for them (one per page load, X-Client-Id).
struct Call { std::string id, params, result; bool done = false; };   // params: the raw tools/call params
struct Tab {
  std::deque<std::shared_ptr<Call>> queue;        // not yet handed out
  Clock::time_point seen, focus;                  // last poll; last poll that said the window has focus (server clock)
  int parked = 0;                                 // polls open now (a tab with one is never purged)
  bool headless = false;                          // the hidden instance (kind=headless): any tab of the user's goes first
};

struct Server {
  std::mutex meshMu;                              // mesh LRU
  std::unordered_map<std::string, MeshEntry> meshes;
  size_t meshBytes = 0, meshCap = size_t(2048) << 20;
  uint64_t tick = 0;

  std::mutex cacheMu;                             // parsed weather + identical-request responses
  std::unordered_map<std::string, std::shared_ptr<const Weather>> weather;
  std::list<std::pair<std::string, std::shared_ptr<const std::string>>> responses;   // most recent first
  size_t responseBytes = 0, responseCap = size_t(256) << 20;

  std::mutex jobsMu;                              // job table, queue, running job; jobsCv signals every change
  std::condition_variable jobsCv;
  std::unordered_map<std::string, std::shared_ptr<Job>> jobs;
  std::deque<std::shared_ptr<Job>> queue;
  std::shared_ptr<Job> running;
  int clientJobs = 2, maxQueue = 32, ttlMin = 15, gpuScenes = 4;

  std::mutex dl;                                  // one download at a time (the .part -> file rename)
  fs::path dir;                                   // disk cache of /proxy
  std::string gpu;                                // device name for /health

  std::mutex mcpMu;                               // agent routes: tabs, calls, session, hidden instance; mcpCv signals every change
  std::condition_variable mcpCv;
  std::unordered_map<std::string, Tab> tabs;      // by X-Client-Id
  std::unordered_map<std::string, std::shared_ptr<Call>> calls;   // relayed, not yet answered
  std::string session;                            // PUT /session: the hidden instance's record for the app to pick up (raw JSON)
  HANDLE hidden = nullptr, job = nullptr;         // the hidden instance's browser process and the job object that ends it
  Clock::time_point hiddenSeen;                   // its start, then its last poll (kind=headless): a minute without one restarts it
  std::wstring browser;                           // --browser, else Chrome or Edge from App Paths ("" = none)
  std::string appUrl;                             // what the hidden instance opens: --app-url, else this server's --web app

  std::mutex repMu;                               // reports: spec writes, the list, deletes
  std::mutex pdfMu;                               // one PDF print at a time (one browser profile)
};

// ---------------------------------------------------------------------------------------------------- helpers
uint64_t fnv1a(const std::string& s) {
  uint64_t h = 1469598103934665603ull;
  for (unsigned char c : s) { h ^= c; h *= 1099511628211ull; }
  return h;
}
std::string hex(uint64_t v) { char b[17]; std::snprintf(b, sizeof b, "%016llx", static_cast<unsigned long long>(v)); return b; }

std::string uuid() {   // random v4 UUID: job ids are unguessable, so users cannot read or cancel each other's jobs
  static std::mutex mu;
  static std::mt19937_64 rng{std::random_device{}() ^ (uint64_t(std::random_device{}()) << 32)};
  uint64_t a, b;
  { std::lock_guard<std::mutex> lock(mu); a = rng(); b = rng(); }
  a = (a & ~0xF000ull) | 0x4000ull;                         // version 4
  b = (b & 0x3FFFFFFFFFFFFFFFull) | 0x8000000000000000ull;  // variant 10
  char s[37];
  std::snprintf(s, sizeof s, "%08llx-%04llx-%04llx-%04llx-%012llx", (unsigned long long)(a >> 32), (unsigned long long)((a >> 16) & 0xFFFF),
                (unsigned long long)(a & 0xFFFF), (unsigned long long)(b >> 48), (unsigned long long)(b & 0xFFFFFFFFFFFFull));
  return s;
}

std::string iso(std::time_t t) {
  if (!t) return "null";
  std::tm tm{};
  gmtime_s(&tm, &t);
  char b[32];
  std::strftime(b, sizeof b, "\"%Y-%m-%dT%H:%M:%SZ\"", &tm);
  return b;
}

std::string json_str(const std::string& s) {   // JSON string literal
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += char(c); }
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else if (c == '\t') o += "\\t";
    else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += char(c);
  }
  return o + "\"";
}

// Mesh names as the TS binding makes them: [A-Za-z0-9._-], else "_"; empty -> "mesh". Uniqueness per run is in the worker.
std::string sanitise(const std::string& n) {
  std::string s;
  for (char c : n) s += (std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' || c == '-') ? c : '_';
  return s.empty() ? std::string("mesh") : s;
}
bool valid_id(const std::string& id) {
  if (id.empty() || id.size() > 64) return false;
  for (char c : id) if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '-')) return false;
  return true;
}

// The only URLs this process ever fetches: literal prefixes (SSRF guard).
const char* const kAllow[] = {
    "https://raw.githubusercontent.com/NREL/EnergyPlus/develop/weather/master.geojson",
    "https://energyplus-weather.s3.amazonaws.com/",
    "https://re.jrc.ec.europa.eu/api/v5_3/tmy?",
};
bool allowed(const std::string& url) {
  for (const char* p : kAllow) if (url.rfind(p, 0) == 0) return true;
  return false;
}

// url -> cached file in S.dir (named by the URL hash); downloads on a miss. curl.exe ships with Windows 10 1803+.
// ponytail: curl.exe through argv (no shell; the URL passed the allowlist); WinHTTP or httplib+OpenSSL if a host lacks curl
bool fetch_cached(Server& S, const std::string& url, fs::path& out, bool& hit, std::string& err) {
  std::lock_guard<std::mutex> lock(S.dl);
  out = S.dir / (hex(fnv1a(url)) + ".bin");
  hit = fs::exists(out);
  if (hit) return true;
  const std::string tmp = out.string() + ".part";
  const intptr_t rc = _spawnlp(_P_WAIT, "curl.exe", "curl.exe", "-fsSL", "--max-time", "120", "-o", tmp.c_str(), url.c_str(), nullptr);
  std::error_code ec;
  if (rc != 0) { fs::remove(tmp, ec); err = "download failed (curl exit " + std::to_string(rc) + "): " + url; return false; }
  fs::rename(tmp, out, ec);
  if (ec) { err = "cannot store " + out.string(); return false; }
  return true;
}

std::string read_file(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  std::ostringstream ss;
  ss << f.rdbuf();
  return ss.str();
}

bool write_file(const fs::path& p, const std::string& body) {
  std::ofstream f(p, std::ios::binary);
  f << body;
  f.close();
  return !f.fail();
}

void text(httplib::Response& res, int status, const std::string& body) { res.status = status; res.set_content(body, "text/plain; charset=utf-8"); }
void json(httplib::Response& res, int status, const std::string& body) { res.status = status; res.set_content(body, "application/json"); }

std::string client_of(const httplib::Request& req) {
  const std::string h = req.get_header_value("X-Client-Id");
  return h.empty() ? "addr:" + req.remote_addr : "id:" + h.substr(0, 64);
}

// ---------------------------------------------------------------------------------------------------- jobs
// Jobs ahead of j (the running one included); 0 for the running job. Caller holds jobsMu.
int position(const Server& S, const Job& j) {
  if (j.state == State::Running) return 0;
  if (j.state != State::Queued) return 0;
  int i = S.running ? 1 : 0;
  for (const auto& q : S.queue) { if (q.get() == &j) return i; ++i; }
  return i;
}

// The job as JSON; a finished job carries its result fields (manifest, values_b64, run_s, cache) inline. Caller holds jobsMu.
std::string view(const Server& S, const Job& j) {
  std::string v = "{\"id\": " + json_str(j.id) + ", \"state\": \"" + name(j.state) + "\", \"position\": " + std::to_string(position(S, j)) +
                  ", \"created\": " + iso(j.created) + ", \"started\": " + iso(j.started) + ", \"finished\": " + iso(j.ended);
  if (j.state == State::Error || j.state == State::Cancelled) v += ", \"status\": " + std::to_string(j.status) + ", \"error\": " + json_str(j.error);
  if (j.state == State::Done && j.body && j.body->size() > 2) return v + ",\n" + j.body->substr(j.body->find('{') + 1);   // merge the result object
  return v + "}";
}

void purge(Server& S) {   // caller holds jobsMu: drop finished jobs past their time to live
  const std::time_t now = std::time(nullptr);
  for (auto it = S.jobs.begin(); it != S.jobs.end();)
    if (finished(it->second->state) && now - it->second->ended > S.ttlMin * 60) it = S.jobs.erase(it);
    else ++it;
}

struct Refusal { int status = 0; std::string body; std::string type = "text/plain; charset=utf-8"; };

// Parses and validates one run request into a job (in the request thread), or explains why not. A request identical to
// an earlier one comes back as a finished job carrying the stored result (response cache).
std::shared_ptr<Job> make_job(Server& S, const httplib::Request& req, Refusal& no) {
  auto fail = [&](int status, const std::string& msg) { no = {status, "error: " + msg + "\n"}; return nullptr; };
  const std::vector<std::string> sensors = req.form.get_fields("sensors"), context = req.form.get_fields("context"), args = req.form.get_fields("args");
  const std::string epwUrl = req.form.get_field("epw_url");
  const bool epwPart = req.form.has_file("epw");
  if (sensors.empty()) return fail(400, "no sensor meshes: give one or more sensors fields with mesh ids (PUT /mesh/{id} first)");
  for (const auto& id : sensors) if (!valid_id(id)) return fail(400, "bad mesh id " + id.substr(0, 80));
  for (const auto& id : context) if (!valid_id(id)) return fail(400, "bad mesh id " + id.substr(0, 80));
  for (const auto& id : context) for (const auto& s : sensors) if (id == s) return fail(400, "mesh " + id + " is both sensor and context");
  if (epwPart && !epwUrl.empty()) return fail(400, "give epw or epw_url, not both");
  if (!epwUrl.empty() && !allowed(epwUrl)) return fail(400, "epw_url not in the allowlist (see GET /openapi.json, operation proxyDownload)");
  const std::string epwText = epwPart ? req.form.get_file("epw").content : std::string();
  const std::string weatherKey = epwPart ? "e:" + hex(fnv1a(epwText)) : epwUrl.empty() ? std::string() : "u:" + epwUrl;

  auto j = std::make_shared<Job>();
  j->id = uuid();
  j->client = client_of(req);
  j->created = std::time(nullptr);
  j->key = weatherKey + "\n";
  for (const auto& s : sensors) j->key += "s:" + s + "\n";
  for (const auto& s : context) j->key += "c:" + s + "\n";
  for (const auto& a : args) j->key += "a:" + a + "\n";

  { // identical request -> the stored body, its cache report rewritten to "hit"
    std::lock_guard<std::mutex> lock(S.cacheMu);
    for (auto it = S.responses.begin(); it != S.responses.end(); ++it)
      if (it->first == j->key) {
        S.responses.splice(S.responses.begin(), S.responses, it);
        std::string body = *it->second;
        if (const size_t p = body.rfind("\"response\": \"miss\""); p != std::string::npos) body.replace(p, 18, "\"response\": \"hit\"");
        j->body = std::make_shared<const std::string>(std::move(body));
        j->state = State::Done;
        j->started = j->ended = j->created;
        return j;
      }
  }

  { // meshes: unknown ids -> 404 {missing}; the job keeps shared pointers, so a later eviction does not affect it
    std::vector<std::string> missing;
    std::lock_guard<std::mutex> lock(S.meshMu);
    for (const auto* ids : {&sensors, &context})
      for (const auto& id : *ids) {
        auto it = S.meshes.find(id);
        if (it == S.meshes.end()) { missing.push_back(id); continue; }
        it->second.used = ++S.tick;
        j->meshes.emplace_back(it->second.mesh, ids == &sensors);
        j->sceneKey += (ids == &sensors ? "s:" : "c:") + id + "\n";
      }
    if (!missing.empty()) {
      std::string m = "{\"missing\": [";
      for (size_t i = 0; i < missing.size(); ++i) m += (i ? ", " : "") + json_str(missing[i]);
      no = {404, m + "]}", "application/json"};
      return nullptr;
    }
  }

  // the CLI's parser on the args, then the HTTP-only rules
  std::vector<std::string> argvS = {"daylight"};
  argvS.insert(argvS.end(), args.begin(), args.end());
  std::vector<char*> av;
  for (auto& s : argvS) av.push_back(s.data());
  std::string err;
  if (cli::parse(static_cast<int>(av.size()), av.data(), j->args, err)) return fail(400, err + "\n" + cli::kUsage);
  cli::Args& a = j->args;
  if (a.help) { no = {200, cli::kUsage}; return nullptr; }
  if (!a.sensors.empty() || !a.context.empty())
    return fail(400, "mesh files are not available over HTTP; PUT /mesh/{id} and name the ids in the sensors / context fields");
  if (!a.epw.empty() || (a.clearSky && (epwPart || !epwUrl.empty())))
    return fail(400, "weather comes from the epw part, epw_url or --clear-sky, one of them");
  if (!a.out.empty() || a.bench || !a.opt.seriesPath.empty() || !a.opt.dumpBitsPath.empty() || !a.opt.dumpSky.empty() || !a.opt.dumpSun.empty())
    return fail(400, "--out, --timeseries, --dump-* and --bench are not available over HTTP");
  a.opt.verbose = false;

  // weather: the parsed-weather cache, else the upload or the proxy cache (parsing outside every lock)
  j->weatherCache = "none";
  if (!weatherKey.empty()) {
    std::shared_ptr<const Weather> w;
    { std::lock_guard<std::mutex> lock(S.cacheMu); if (auto it = S.weather.find(weatherKey); it != S.weather.end()) w = it->second; }
    if (w) j->weatherCache = "hit";
    else {
      std::string textEpw = epwText;
      const std::string label = epwPart ? req.form.get_file("epw").filename : epwUrl;
      if (!epwPart) {
        fs::path p;
        bool hit = false;
        if (!fetch_cached(S, epwUrl, p, hit, err)) return fail(502, err);
        textEpw = read_file(p);
      }
      auto parsed = std::make_shared<Weather>();
      std::istringstream in(textEpw);
      if (!read_epw(in, label, *parsed, err)) return fail(400, err);
      { std::lock_guard<std::mutex> lock(S.cacheMu); S.weather[weatherKey] = parsed; }
      w = parsed;
      j->weatherCache = "miss";
    }
    j->weather = *w;
    j->haveWeather = true;
  }
  if (const int rc = cli::prepare(a, j->weather, j->haveWeather, err)) return fail(rc == 1 ? 400 : 500, err);
  j->sceneKey += a.opt.selfOcclude ? "self" : "noself";
  return j;
}

// Queues a fresh job (limits checked) or registers a cached one; false with a refusal when the limits say no.
bool submit(Server& S, const std::shared_ptr<Job>& j, Refusal& no) {
  std::lock_guard<std::mutex> lock(S.jobsMu);
  purge(S);
  if (j->state == State::Queued) {
    int mine = 0;
    for (const auto& q : S.queue) mine += q->client == j->client;
    mine += S.running && S.running->client == j->client;
    if (mine >= S.clientJobs) {
      no = {429, "error: " + std::to_string(mine) + " jobs of this client are queued or running (limit " + std::to_string(S.clientJobs) +
                     "); wait for one to finish or DELETE /jobs/{id}\n"};
      return false;
    }
    if (int(S.queue.size()) >= S.maxQueue) { no = {503, "error: the queue is full (" + std::to_string(S.maxQueue) + " jobs); retry shortly\n"}; return false; }
    S.queue.push_back(j);
  }
  S.jobs[j->id] = j;
  S.jobsCv.notify_all();
  return true;
}

// The GPU owner: one job at a time, in submission order.
void worker(Server& S) {
  for (;;) {
    std::shared_ptr<Job> j;
    {
      std::unique_lock<std::mutex> lock(S.jobsMu);
      S.jobsCv.wait(lock, [&] { return !S.queue.empty(); });
      j = S.queue.front();
      S.queue.pop_front();
      j->state = State::Running;
      j->started = std::time(nullptr);
      S.running = j;
      S.jobsCv.notify_all();
    }
    // meshes copied from the shared cache entries, names made unique per run as the TS binding does
    // ponytail: run() takes meshes by value, so each run copies the cached arrays (~10 ms per 44 MB); a pointer overload if it shows
    std::vector<Mesh> meshes;
    std::unordered_map<std::string, int> seen;
    for (const auto& [mesh, sensor] : j->meshes) {
      Mesh m = *mesh;
      m.sensor = sensor;
      std::string lower = m.name;
      for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      if (const int n = seen[lower]++) m.name += "_" + std::to_string(n + 1);
      meshes.push_back(std::move(m));
    }
    Options opt = j->args.opt;
    opt.sceneKey = j->sceneKey;
    opt.residentScenes = S.gpuScenes;
    opt.cancel = &j->cancel;
    Result r;
    std::string err;
    const auto t1 = Clock::now();
    const bool ok = run(meshes, j->haveWeather ? &j->weather : nullptr, opt, r, err);
    const double runS = std::chrono::duration<double>(Clock::now() - t1).count();
    std::shared_ptr<const std::string> body;
    if (ok) {
      const std::string b64 = httplib::detail::base64_encode(std::string(reinterpret_cast<const char*>(r.values.data()), r.values.size() * sizeof(double)));
      char tail[256];
      std::snprintf(tail, sizeof tail, "\",\n  \"run_s\": %.3f,\n  \"total_s\": %.3f,\n  \"cache\": {\"response\": \"miss\", \"scene\": \"%s\", \"weather\": \"%s\"}",
                    runS, double(std::time(nullptr) - j->created), r.sceneReused ? "reused" : "built", j->weatherCache.c_str());
      body = std::make_shared<const std::string>(cli::manifest_json(r, "\"values_b64\": \"" + b64 + tail));
      std::lock_guard<std::mutex> lock(S.cacheMu);
      S.responses.emplace_front(j->key, body);
      S.responseBytes += body->size();
      while (S.responseBytes > S.responseCap && S.responses.size() > 1) { S.responseBytes -= S.responses.back().second->size(); S.responses.pop_back(); }
    }
    std::lock_guard<std::mutex> lock(S.jobsMu);
    if (ok) { j->body = body; j->state = State::Done; }
    else if (j->cancel) { j->state = State::Cancelled; j->status = 409; j->error = "error: cancelled"; }
    else { j->state = State::Error; j->status = 500; j->error = "error: " + err; }
    j->ended = std::time(nullptr);
    S.running = nullptr;
    S.jobsCv.notify_all();
  }
}

// ---------------------------------------------------------------------------------------------------- agents (--mcp)
// POST /mcp answers the MCP handshake and the tool list from the embedded mcp.json itself and relays each tools/call to
// an app tab (web/src/mcp), which long-polls GET /bridge/next and answers on POST /bridge/result/{id}.
std::string tool_error(const std::string& msg) {   // a CallToolResult the agent can act on
  return "{\"content\": [{\"type\": \"text\", \"text\": " + json_str(msg) + "}], \"isError\": true}";
}

// The tab a call goes to: a live one (a poll open, or one within 5 s), the user's tabs before the hidden instance, then
// the one focused last, then the one seen last; "" when none. Caller holds mcpMu.
std::string target(const Server& S) {
  const auto now = Clock::now();
  const std::pair<const std::string, Tab>* best = nullptr;
  for (const auto& e : S.tabs) {
    const Tab& t = e.second;
    if (!t.parked && now - t.seen > std::chrono::seconds(5)) continue;
    if (!best || std::make_tuple(!t.headless, t.focus, t.seen) > std::make_tuple(!best->second.headless, best->second.focus, best->second.seen)) best = &e;
  }
  return best ? best->first : "";
}

// The browser for the hidden instance (and report PDFs) when --browser names none: the App Paths entry of chrome.exe,
// then of msedge.exe, per user before per machine; "" when neither is installed.
std::wstring find_browser() {
  for (const wchar_t* exe : {L"chrome.exe", L"msedge.exe"})
    for (const HKEY root : {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}) {
      wchar_t buf[2048];
      DWORD bytes = sizeof buf;   // RRF_RT_REG_SZ takes REG_EXPAND_SZ too, expanded
      const std::wstring key = std::wstring(L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\") + exe;
      if (RegGetValueW(root, key.c_str(), nullptr, RRF_RT_REG_SZ, nullptr, buf, &bytes) != ERROR_SUCCESS) continue;
      std::wstring p = buf;
      if (p.size() > 1 && p.front() == L'"' && p.back() == L'"') p = p.substr(1, p.size() - 2);
      std::error_code ec;
      if (fs::is_regular_file(p, ec)) return p;
    }
  return {};
}

// Starts exe with each argument quoted (agent.h quote): no console window, no inherited handles (the listening socket
// stays ours), and inside `job` when given, before it can start children of its own. The process handle, or nullptr.
HANDLE spawn(const std::wstring& exe, const std::vector<std::wstring>& args, HANDLE job, std::string& err) {
  std::wstring cmd = quote(exe);
  for (const auto& a : args) cmd += L" " + quote(a);
  STARTUPINFOW si{};
  si.cb = sizeof si;
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr, &si, &pi)) {
    err = "cannot start " + fs::path(exe).u8string() + " (error " + std::to_string(GetLastError()) + ")";
    return nullptr;
  }
  if (job && !AssignProcessToJobObject(job, pi.hProcess)) {
    err = "cannot put the browser in a job object (error " + std::to_string(GetLastError()) + ")";
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return nullptr;
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  return pi.hProcess;
}

void stop_hidden(Server& S) {   // caller holds mcpMu
  if (S.job) CloseHandle(S.job);   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: the browser and its children end here
  if (S.hidden) { WaitForSingleObject(S.hidden, 5000); CloseHandle(S.hidden); }   // gone, so a new one can take its profile
  S.job = S.hidden = nullptr;
}

// No app tab is open: start ONE headless browser on the app (#headless makes the page a bridge tab of kind headless),
// in a job object, so it ends with the server (even a crash) or when the app picks its session up (DELETE /session).
// One that has not polled for a minute (its page crashed, or never reached /bridge/next) is started again. false with
// the agent's next step when that cannot work. Caller holds mcpMu.
// ponytail: a minute without a poll counts as wedged, so a page whose main thread blocks that long restarts too (its
// models lost); raise the minute if that shows
bool start_hidden(Server& S, std::string& why) {
  const bool alive = S.hidden && WaitForSingleObject(S.hidden, 0) == WAIT_TIMEOUT;
  if (alive && Clock::now() - S.hiddenSeen < std::chrono::seconds(60)) return true;   // starting, or polled within the minute
  stop_hidden(S);
  if (S.appUrl.empty()) {
    why = "No daylight app tab is open on this machine: ask the user to open the app and keep its tab open (LAN tabs cannot "
          "be driven), or to start daylight_server with --web or --app-url so it can start a hidden instance itself.";
    return false;
  }
  const std::string ask = " ask the user to open " + S.appUrl + " and keep the tab open";
  if (S.browser.empty()) {
    why = "No daylight app tab is open and no Chrome or Edge was found for a hidden instance:" + ask + ", or to start daylight_server with --browser PATH.";
    return false;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim{};
  lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  S.job = CreateJobObjectW(nullptr, nullptr);
  std::string err = "cannot create a job object";
  if (S.job && SetInformationJobObject(S.job, JobObjectExtendedLimitInformation, &lim, sizeof lim))
    S.hidden = spawn(S.browser, {L"--headless", L"--no-first-run", L"--no-default-browser-check", L"--user-data-dir=" + (S.dir / "agent-profile").wstring(),
                                 fs::path(S.appUrl + "#headless").wstring()}, S.job, err);
  if (S.hidden) { S.hiddenSeen = Clock::now(); return true; }
  stop_hidden(S);
  why = "No daylight app tab is open and the hidden instance did not start (" + err + "):" + ask + ".";
  return false;
}

// tools/call: queued for the target tab (with none open, the hidden instance is started and given up to 30 s to poll)
// and answered with the tab's CallToolResult, raw. A client that hangs up cancels a call no tab has taken yet.
// ponytail: every answer within 55 s (Claude Desktop ends calls at about 60 s; long steps answer `running` in the tab),
// and no re-delivery of a call whose tab closed (the timeout text sends the agent to app_state)
std::string relay(Server& S, const httplib::Request& req, const std::string& params) {
  const auto end = Clock::now() + std::chrono::seconds(55);
  std::unique_lock<std::mutex> lock(S.mcpMu);
  std::string key = target(S), why;
  if (key.empty()) {
    if (!start_hidden(S, why)) return tool_error(why);
    const auto ready = std::min(end, Clock::now() + std::chrono::seconds(30));
    while ((key = target(S)).empty() && Clock::now() < ready && !req.is_connection_closed()) S.mcpCv.wait_for(lock, std::chrono::seconds(1));
    if (key.empty())
      return tool_error("No daylight app tab is open and the hidden instance (" + S.appUrl + ") did not poll this server (/bridge/next) within 30 s. "
                        "Call again once: it may still be starting, and one that stops polling is started again after a minute. If that fails "
                        "too, its page cannot reach this server: ask the user to open " + S.appUrl + " and keep the tab open, and to check that it "
                        "shows the daylight app, that --app-url names this machine as localhost or 127.0.0.1, and that a dev server forwards "
                        "/bridge to daylight_server.");
  }
  auto c = std::make_shared<Call>();
  c->id = uuid();
  c->params = params;
  S.calls[c->id] = c;
  S.tabs[key].queue.push_back(c);
  S.mcpCv.notify_all();
  while (!c->done && Clock::now() < end && !req.is_connection_closed()) S.mcpCv.wait_for(lock, std::chrono::seconds(1));
  S.calls.erase(c->id);
  if (auto t = S.tabs.find(key); t != S.tabs.end()) t->second.queue.erase(std::remove(t->second.queue.begin(), t->second.queue.end(), c), t->second.queue.end());
  return c->done ? c->result : tool_error("The app did not answer within 55 s; the step may still be running in the app: call app_state.");
}

// ---------------------------------------------------------------------------------------------------- docs pages
const char* const kDocs = R"(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>daylight_server API - Swagger UI</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.2/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.2/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: 'openapi.json', dom_id: '#ui', deepLinking: true, displayOperationId: true, defaultModelsExpandDepth: 1 });</script>
</body></html>
)";
const char* const kRedoc = R"(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>daylight_server API - ReDoc</title></head>
<body><redoc spec-url="openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js"></script>
</body></html>
)";

}  // namespace

int main(int argc, char** argv) {
  int port = 8080;
  size_t maxMb = 2048;
  std::string web;
  bool mcp = false;
  Server S;
  const wchar_t* local = _wgetenv(L"LOCALAPPDATA");   // wide: a user name outside the ANSI code page stays intact
  S.dir = fs::path(local ? local : L".") / "daylight_server";
  for (int i = 1; i < argc; ++i) {
    const std::string f = argv[i];
    auto val = [&]() -> const char* { return i + 1 < argc ? argv[++i] : ""; };
    if (f == "--port") port = std::atoi(val());
    else if (f == "--web") web = val();
    else if (f == "--mcp") mcp = true;
    else if (f == "--browser") S.browser = fs::path(val()).wstring();
    else if (f == "--app-url") S.appUrl = val();
    else if (f == "--cache") S.dir = val();
    else if (f == "--max-mb") maxMb = static_cast<size_t>(std::atoll(val()));
    else if (f == "--mesh-cache-mb") S.meshCap = static_cast<size_t>(std::atoll(val())) << 20;
    else if (f == "--client-jobs") S.clientJobs = std::max(1, std::atoi(val()));
    else if (f == "--max-queue") S.maxQueue = std::max(1, std::atoi(val()));
    else if (f == "--job-ttl-min") S.ttlMin = std::max(1, std::atoi(val()));
    else if (f == "--gpu-scenes") S.gpuScenes = std::max(1, std::atoi(val()));
    else {
      std::fprintf(stderr, "usage: daylight_server [--port 8080] [--web DIR] [--cache DIR] [--max-mb 2048] [--mesh-cache-mb 2048]\n"
                           "                       [--client-jobs 2] [--max-queue 32] [--job-ttl-min 15] [--gpu-scenes 4]\n"
                           "                       [--mcp] [--browser PATH] [--app-url URL]\n");
      return 1;
    }
  }
  if (mcp && S.browser.empty()) S.browser = find_browser();
  if (S.appUrl.empty() && !web.empty()) S.appUrl = "http://127.0.0.1:" + std::to_string(port) + "/";
  // POST /mcp answers from the embedded mcp.json (tools, instructions) and openapi.json (version), as raw JSON tokens.
  const std::string mcpDoc(reinterpret_cast<const char*>(mcp_json), mcp_json_len), api(reinterpret_cast<const char*>(openapi_json), openapi_json_len);
  const std::string tools = member(mcpDoc, "tools"), instructions = member(mcpDoc, "instructions"), version = member(member(api, "info"), "version");
  if (tools.empty() || tools[0] != '[' || instructions.empty() || instructions[0] != '"' || version.empty()) {
    std::fprintf(stderr, "error: the embedded mcp.json lacks tools or instructions (or openapi.json info.version); fix it and rebuild\n");
    return 1;
  }
  std::error_code ec;
  fs::create_directories(S.dir, ec);
  if (cudaDeviceProp p{}; cudaGetDeviceProperties(&p, 0) == cudaSuccess) S.gpu = p.name;

  httplib::Server svr;
  svr.new_task_queue = [] { return new httplib::ThreadPool(16, 128); };   // long polls and waiting /run calls never starve uploads
  svr.set_payload_max_length(maxMb << 20);
  // The page's USD viewer runs a threaded wasm core (SharedArrayBuffer): its files must come cross-origin isolated.
  const httplib::Headers isolation{{"Cross-Origin-Opener-Policy", "same-origin"}, {"Cross-Origin-Embedder-Policy", "require-corp"}};
  if (!web.empty() && !svr.set_mount_point("/", web, isolation)) { std::fprintf(stderr, "error: --web %s is not a directory\n", web.c_str()); return 1; }
  svr.set_logger([](const httplib::Request& req, const httplib::Response& res) {
    if (res.status == 204 && req.path == "/bridge/next") return;   // an idle poll: one per open app tab every 25 s
    std::fprintf(stderr, "%s %s -> %d\n", req.method.c_str(), req.path.c_str(), res.status);
  });
  // Agent routes (/mcp, /bridge/*, /files, /reports*, /session): 404 without --mcp, and only this machine may use them
  // (agent.h local_request). This runs before a body is read and before the --web files.
  svr.set_pre_routing_handler([&](const httplib::Request& req, httplib::Response& res) {
    const auto under = [&](std::string_view p) { return req.path.compare(0, p.size(), p) == 0 && (req.path.size() == p.size() || req.path[p.size()] == '/'); };
    if (!under("/mcp") && !under("/bridge") && !under("/files") && !under("/reports") && !under("/session")) return httplib::Server::HandlerResponse::Unhandled;
    if (!mcp) text(res, 404, "error: agent routes are off (start daylight_server with --mcp)\n");
    else if (!local_request(req.remote_addr, req.headers, req.method == "POST" && (under("/mcp") || under("/bridge"))))
      text(res, 403, "error: agent routes answer only on this machine (Host localhost, 127.0.0.1 or [::1]; same origin; no proxy; "
                     "JSON bodies as Content-Type: application/json)\n");
    else return httplib::Server::HandlerResponse::Unhandled;
    return httplib::Server::HandlerResponse::Handled;
  });

  // ---- meta
  svr.Get("/health", [&](const httplib::Request&, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(S.jobsMu);
    json(res, 200, "{\"status\": \"ok\", \"gpu\": " + json_str(S.gpu) + ", \"queued\": " + std::to_string(S.queue.size()) +
                       ", \"running\": " + (S.running ? "true" : "false") + ", \"jobs_retained\": " + std::to_string(S.jobs.size()) + "}");
  });
  svr.Get("/openapi.json", [](const httplib::Request&, httplib::Response& res) {
    res.set_content(std::string(reinterpret_cast<const char*>(openapi_json), openapi_json_len), "application/json");
  });
  svr.Get("/llms.txt", [](const httplib::Request&, httplib::Response& res) {
    res.set_content(std::string(reinterpret_cast<const char*>(llms_txt), llms_txt_len), "text/plain; charset=utf-8");
  });
  svr.Get("/docs", [](const httplib::Request&, httplib::Response& res) { res.set_content(kDocs, "text/html; charset=utf-8"); });
  svr.Get("/redoc", [](const httplib::Request&, httplib::Response& res) { res.set_content(kRedoc, "text/html; charset=utf-8"); });
  if (web.empty()) svr.Get("/", [](const httplib::Request&, httplib::Response& res) { res.set_redirect("/docs"); });

  // ---- meshes
  svr.Get(R"(/mesh/([A-Za-z0-9-]{1,64}))", [&](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(S.meshMu);
    res.status = S.meshes.count(req.matches[1]) ? 204 : 404;
  });
  svr.Put(R"(/mesh/([A-Za-z0-9-]{1,64}))", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string id = req.matches[1];
    const std::string nm = sanitise(req.has_param("name") ? req.get_param_value("name") : id);
    std::vector<Mesh> ms;
    std::string err;
    if (!read_dmesh(req.body.data(), req.body.size(), nm, ms, err)) return text(res, 400, "error: " + err + "\n");
    if (ms.empty()) return text(res, 400, "error: " + nm + ": mesh has no faces\n");
    auto mesh = std::make_shared<const Mesh>(std::move(ms[0]));   // parsed outside the lock
    std::lock_guard<std::mutex> lock(S.meshMu);
    if (auto it = S.meshes.find(id); it != S.meshes.end()) { S.meshBytes -= it->second.bytes; S.meshes.erase(it); }
    // ponytail: RAM LRU, meshes come back after a restart with one PUT round trip; a disk cache if that ever hurts
    while (S.meshBytes + req.body.size() > S.meshCap && !S.meshes.empty()) {
      auto oldest = S.meshes.begin();
      for (auto j = S.meshes.begin(); j != S.meshes.end(); ++j) if (j->second.used < oldest->second.used) oldest = j;
      S.meshBytes -= oldest->second.bytes;
      S.meshes.erase(oldest);
    }
    S.meshBytes += req.body.size();
    S.meshes[id] = MeshEntry{mesh, req.body.size(), ++S.tick};
    res.status = 204;
  });

  // ---- weather downloads
  svr.Get("/proxy", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string url = req.get_param_value("url");
    if (!allowed(url)) return text(res, 400, "error: url not in the allowlist\n");
    fs::path p;
    bool hit = false;
    std::string err;
    if (!fetch_cached(S, url, p, hit, err)) return text(res, 502, "error: " + err + "\n");
    res.set_header("Cache-Control", "max-age=86400");
    res.set_header("X-Daylight-Cache", hit ? "hit" : "miss");
    res.set_content(read_file(p), url.find(".geojson") != std::string::npos ? "application/geo+json" : "text/plain");
  });

  // ---- jobs
  const auto refuse = [](httplib::Response& res, const Refusal& no) {
    res.status = no.status;
    if (no.status == 429 || no.status == 503) res.set_header("Retry-After", no.status == 429 ? "5" : "10");
    res.set_content(no.body, no.type);
  };
  svr.Post("/jobs", [&](const httplib::Request& req, httplib::Response& res) {
    Refusal no;
    auto j = make_job(S, req, no);
    if (!j || !submit(S, j, no)) return refuse(res, no);
    std::lock_guard<std::mutex> lock(S.jobsMu);
    json(res, j->state == State::Done ? 200 : 202, view(S, *j));
    res.set_header("Location", "/jobs/" + j->id);
  });
  svr.Get("/jobs", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string me = client_of(req);
    std::lock_guard<std::mutex> lock(S.jobsMu);
    std::string mine;
    for (const auto& [id, j] : S.jobs)
      if (j->client == me) mine += (mine.empty() ? "" : ", ") + std::string("{\"id\": ") + json_str(j->id) + ", \"state\": \"" + name(j->state) + "\", \"position\": " + std::to_string(position(S, *j)) + "}";
    json(res, 200, "{\"queued\": " + std::to_string(S.queue.size()) + ", \"running\": " + (S.running ? "true" : "false") + ", \"yours\": [" + mine + "]}");
  });
  svr.Get(R"(/jobs/([0-9a-f-]{36}))", [&](const httplib::Request& req, httplib::Response& res) {
    const int wait = std::min(30, std::max(0, req.has_param("wait") ? std::atoi(req.get_param_value("wait").c_str()) : 0));
    std::unique_lock<std::mutex> lock(S.jobsMu);
    auto it = S.jobs.find(req.matches[1]);
    if (it == S.jobs.end()) return text(res, 404, "error: no such job (finished jobs are kept " + std::to_string(S.ttlMin) + " minutes)\n");
    auto j = it->second;
    if (wait > 0 && !finished(j->state)) {   // long poll: return as soon as the state or the queue position changes
      const State s0 = j->state;
      const int p0 = position(S, *j);
      S.jobsCv.wait_for(lock, std::chrono::seconds(wait), [&] { return j->state != s0 || position(S, *j) != p0; });
    }
    json(res, 200, view(S, *j));
  });
  svr.Delete(R"(/jobs/([0-9a-f-]{36}))", [&](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(S.jobsMu);
    auto it = S.jobs.find(req.matches[1]);
    if (it == S.jobs.end()) return text(res, 404, "error: no such job\n");
    auto j = it->second;
    if (j->state == State::Queued) {
      for (auto q = S.queue.begin(); q != S.queue.end(); ++q) if (*q == j) { S.queue.erase(q); break; }
      j->state = State::Cancelled; j->status = 409; j->error = "error: cancelled"; j->ended = std::time(nullptr);
      S.jobsCv.notify_all();
    } else if (j->state == State::Running) j->cancel = true;   // the worker stops at the next chunk and marks it cancelled
    json(res, 200, view(S, *j));
  });

  // ---- synchronous run: submit + wait, the original API (curl, simple clients)
  svr.Post("/run", [&](const httplib::Request& req, httplib::Response& res) {
    Refusal no;
    auto j = make_job(S, req, no);
    if (!j || !submit(S, j, no)) return refuse(res, no);
    std::unique_lock<std::mutex> lock(S.jobsMu);
    S.jobsCv.wait(lock, [&] { return finished(j->state); });
    if (j->state == State::Done) return json(res, 200, *j->body);
    text(res, j->status, j->error + "\n");
  });

  // ---- agents (--mcp; this machine only, see the gate above). MCP over HTTP with JSON answers (no SSE, no sessions):
  // revisions 2025-11-25, 2025-06-18 and 2025-03-26. JSON-RPC errors come with HTTP 200, ids are echoed as raw tokens.
  svr.Post("/mcp", [&](const httplib::Request& req, httplib::Response& res) {
    const auto known = [](const std::string& v) { return v == "2025-11-25" || v == "2025-06-18" || v == "2025-03-26"; };
    const std::string method = member(req.body, "method"), id = member(req.body, "id"), pv = req.get_header_value("MCP-Protocol-Version");
    if (method != "\"initialize\"" && !pv.empty() && !known(pv))   // a newer client's probe: the 400 makes it fall back to initialize
      return text(res, 400, "error: MCP-Protocol-Version " + pv + " is not supported (2025-11-25, 2025-06-18, 2025-03-26)\n");
    if (method.size() < 2 || method[0] != '"')
      return json(res, 400, R"({"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "Invalid Request: one JSON-RPC request or notification per POST"}})");
    if (id.empty()) { res.status = 202; return; }   // a notification; notifications/cancelled too: hanging up cancels
    const auto answer = [&](const std::string& result) { json(res, 200, "{\"jsonrpc\": \"2.0\", \"id\": " + id + ", \"result\": " + result + "}"); };
    const auto rpcError = [&](int code, const std::string& msg) {
      json(res, 200, "{\"jsonrpc\": \"2.0\", \"id\": " + id + ", \"error\": {\"code\": " + std::to_string(code) + ", \"message\": " + json_str(msg) + "}}");
    };
    if (method == "\"initialize\"") {
      const std::string asked = member(member(req.body, "params"), "protocolVersion");
      return answer("{\"protocolVersion\": " + (asked.size() > 2 && known(asked.substr(1, asked.size() - 2)) ? asked : std::string("\"2025-11-25\"")) +
                    ", \"capabilities\": {\"tools\": {}}, \"serverInfo\": {\"name\": \"daylight_server\", \"version\": " + version +
                    "}, \"instructions\": " + instructions + "}");
    }
    if (method == "\"ping\"") return answer("{}");
    if (method == "\"tools/list\"") return answer("{\"tools\": " + tools + "}");
    if (method != "\"tools/call\"") return rpcError(-32601, "Method not found: " + method.substr(1, method.size() - 2));
    std::string params = member(req.body, "params");
    const std::string tool = member(params, "name");
    if (tool.size() < 2 || tool[0] != '"') return rpcError(-32602, "Invalid params: tools/call takes {name, arguments}");
    if (member(params, "arguments").empty())   // some clients leave it out for a tool without arguments
      params = "{\"arguments\": {}" + std::string(params[ws(params, 1)] == '}' ? "" : ", ") + params.substr(1);
    answer(relay(S, req, params));
  });
  svr.Get("/mcp", [](const httplib::Request&, httplib::Response& res) {
    res.set_header("Allow", "POST");
    text(res, 405, "error: POST JSON-RPC messages to /mcp; this server opens no SSE stream\n");
  });
  // The app tab's side: one long poll always open per page load (X-Client-Id), answered with the next call for that tab.
  // wait=0 is a ping (liveness, focus=1 when the window has focus) and never hands out a call.
  svr.Get("/bridge/next", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string me = req.get_header_value("X-Client-Id");
    if (!valid_id(me)) return text(res, 400, "error: X-Client-Id must be this page load's id ([A-Za-z0-9-], 1-64 characters)\n");
    const int wait = std::min(25, std::max(0, std::atoi(req.get_param_value("wait").c_str())));
    std::unique_lock<std::mutex> lock(S.mcpMu);
    const auto now = Clock::now();
    Tab& t = S.tabs[me];   // a reference into the map stays valid while other tabs are erased
    t.seen = now;
    if (req.get_param_value("focus") == "1") t.focus = now;
    t.headless = req.get_param_value("kind") == "headless";
    if (t.headless) S.hiddenSeen = now;   // start_hidden restarts one silent for a minute
    for (auto it = S.tabs.begin(); it != S.tabs.end();)   // tabs gone for a minute
      if (!it->second.parked && it->second.queue.empty() && now - it->second.seen > std::chrono::seconds(60)) it = S.tabs.erase(it);
      else ++it;
    S.mcpCv.notify_all();   // a relay waiting for a tab (the hidden instance starting) looks again
    if (wait == 0) { res.status = 204; return; }
    ++t.parked;
    while (t.queue.empty() && Clock::now() < now + std::chrono::seconds(wait) && !req.is_connection_closed()) S.mcpCv.wait_for(lock, std::chrono::seconds(1));
    --t.parked;
    const bool closed = req.is_connection_closed();   // the tab closed or reloaded: no longer a target (its next poll says otherwise)
    t.seen = closed ? Clock::time_point{} : Clock::now();
    if (t.queue.empty() || closed) { res.status = 204; return; }   // a closed poll leaves the call queued
    const auto c = t.queue.front();
    t.queue.pop_front();
    json(res, 200, "{\"id\": " + json_str(c->id) + ", \"params\": " + c->params + "}");
  });
  svr.Post(R"(/bridge/result/([0-9a-f-]{36}))", [&](const httplib::Request& req, httplib::Response& res) {
    if (!is_object(req.body)) return text(res, 400, "error: the body is one CallToolResult object\n");
    std::lock_guard<std::mutex> lock(S.mcpMu);
    auto it = S.calls.find(req.matches[1]);
    if (it == S.calls.end() || it->second->done) return text(res, 404, "error: no such call (answered already, or past its 55 s)\n");
    it->second->result = req.body;
    it->second->done = true;
    S.mcpCv.notify_all();
    res.status = 204;
  });
  // Open by path: one file's bytes, or a folder's model files (recursive) for the tab to fetch one after another.
  svr.Get("/files", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string arg = req.get_param_value("path");
    if (!local_path(arg)) return text(res, 400, "error: path must be an absolute local path such as C:\\models\\house.usdz (no network or device paths)\n");
    const fs::path p = fs::u8path(arg);
    const size_t cap = maxMb << 20;
    std::error_code fe;
    if (fs::is_regular_file(p, fe)) {
      if (!served_ext(p.extension().u8string()))
        return text(res, 400, "error: not a model, texture or weather file (.usd .usda .usdc .usdz .glb .gltf .obj .mtl .bin .png .jpg .jpeg .webp .exr .hdr .epw)\n");
      if (fs::file_size(p, fe) > cap) return text(res, 400, "error: the file is over --max-mb " + std::to_string(maxMb) + "\n");
      return res.set_file_content(p.u8string(), "application/octet-stream");
    }
    if (!fs::is_directory(p, fe)) return text(res, 404, "error: no such file or folder: " + arg + "\n");
    std::string files;
    size_t count = 0, bytes = 0;
    // no dot or __MACOSX entries (the Model panel skips them too); directory symlinks and junctions are not followed
    for (fs::recursive_directory_iterator it(p, fs::directory_options::skip_permission_denied, fe), done; !fe && it != done; it.increment(fe)) {
      const std::string leaf = it->path().filename().u8string();
      if (leaf.rfind('.', 0) == 0 || leaf == "__MACOSX") { it.disable_recursion_pending(); continue; }
      std::error_code ee;   // a broken link skips its entry, not the rest of the folder
      if (!it->is_regular_file(ee) || !served_ext(it->path().extension().u8string())) continue;
      const uintmax_t size = it->file_size(ee);
      if (ee) continue;
      bytes += static_cast<size_t>(size);
      if (++count > 2000 || bytes > cap)
        return text(res, 400, "error: " + arg + " holds over 2000 model files or " + std::to_string(maxMb) + " MB: open a subfolder or single files\n");
      files += std::string(files.empty() ? "" : ", ") + "{\"path\": " + json_str(it->path().lexically_relative(p).generic_u8string()) +
               ", \"bytes\": " + std::to_string(size) + "}";
    }
    json(res, 200, "{\"path\": " + json_str(p.u8string()) + ", \"files\": [" + files + "]}");
  });
  // Reports, one folder each under <cache>/reports/<id>: report.json (the spec the app saves and the user edits there),
  // index.html (the page the app renders from it) and report.pdf (that page printed by a headless browser). Absolute: the
  // browser takes file:/// URLs and an absolute --print-to-pdf path (a relative one prints nothing).
  const fs::path reports = fs::absolute(S.dir, ec) / "reports";
  svr.Get("/reports", [&](const httplib::Request&, httplib::Response& res) {
    std::string list;
    std::error_code fe;
    std::lock_guard<std::mutex> lock(S.repMu);
    for (fs::directory_iterator it(reports, fe), end; !fe && it != end; it.increment(fe)) {
      const std::string id = it->path().filename().u8string();
      std::error_code ee;
      if (!valid_id(id) || !fs::is_regular_file(it->path() / "report.json", ee)) continue;
      // the spec as a JSON string: one damaged file cannot break the list (the app parses each spec by itself)
      list += std::string(list.empty() ? "" : ", ") + "{\"id\": " + json_str(id) + ", \"pdf\": " +
              (fs::is_regular_file(it->path() / "report.pdf", ee) ? "true" : "false") + ", \"spec\": " + json_str(read_file(it->path() / "report.json")) + "}";
    }
    json(res, 200, "[" + list + "]");
  });
  svr.Put(R"(/reports/([a-z0-9-]{1,64}))", [&](const httplib::Request& req, httplib::Response& res) {
    if (req.body.size() > (size_t(1) << 20)) return text(res, 413, "error: a report spec is at most 1 MB\n");
    if (!is_object(req.body)) return text(res, 400, "error: the body is one JSON object (the report spec)\n");
    const fs::path dir = reports / std::string(req.matches[1]), part = dir / "report.json.part";
    std::error_code fe;
    std::lock_guard<std::mutex> lock(S.repMu);
    fs::create_directories(dir, fe);
    const bool written = write_file(part, req.body);   // then renamed: a crash mid-write leaves the old spec whole
    if (written) fs::rename(part, dir / "report.json", fe);
    if (!written || fe) return text(res, 500, "error: cannot store " + (dir / "report.json").u8string() + "\n");
    res.status = 204;
  });
  svr.Delete(R"(/reports/([a-z0-9-]{1,64}))", [&](const httplib::Request& req, httplib::Response& res) {
    const fs::path dir = reports / std::string(req.matches[1]);
    std::error_code fe;
    std::lock_guard<std::mutex> lock(S.repMu);
    if (!fs::is_directory(dir, fe)) return text(res, 404, "error: no such report\n");
    fs::remove(dir / "report.pdf", fe);   // first: a PDF open in a viewer refuses, and the report stays whole
    if (!fe) fs::remove_all(dir, fe);
    if (fe) return text(res, 409, "error: the report's PDF is open in another program or printing: close it and delete again\n");
    res.status = 204;
  });
  // Prints the page the app rendered (self-contained: CSS, fonts and images inline) to PDF with the browser in headless
  // mode, one print at a time, and answers where the PDF is, its pages and fonts (fallback: faces kit-ui does not ship).
  svr.Post(R"(/reports/([a-z0-9-]{1,64})/pdf)", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string id = req.matches[1];
    const fs::path dir = reports / id, page = dir / "index.html", tmp = dir / "report.new.pdf", out = dir / "report.pdf";
    std::error_code fe;
    if (!fs::is_regular_file(dir / "report.json", fe)) return text(res, 404, "error: no such report: save its spec first (PUT /reports/{id})\n");
    if (S.browser.empty()) return text(res, 500, "error: no Chrome or Edge found to print the PDF: start daylight_server with --browser PATH\n");
    std::lock_guard<std::mutex> lock(S.pdfMu);
    fs::remove(tmp, fe);   // a stale one would pass the %PDF- check below
    if (!write_file(page, req.body)) return text(res, 500, "error: cannot write " + page.u8string() + "\n");
    const std::string url = file_url(page.u8string());   // ASCII: every other byte is percent-encoded
    std::string err;
    const HANDLE p = spawn(S.browser, {L"--headless", L"--no-first-run", L"--no-default-browser-check", L"--no-pdf-header-footer", L"--virtual-time-budget=10000",
                                       L"--user-data-dir=" + (S.dir / "pdf-profile").wstring(), L"--print-to-pdf=" + tmp.wstring(), std::wstring(url.begin(), url.end())},
                           nullptr, err);
    if (!p) return text(res, 500, "error: " + err + "\n");
    // ponytail: TerminateProcess ends the browser process only; its helpers exit when their pipe to it closes (a job
    // object, as for the hidden instance, if strays ever show)
    DWORD code = 1;
    if (WaitForSingleObject(p, 30000) == WAIT_OBJECT_0) GetExitCodeProcess(p, &code);
    else { TerminateProcess(p, 1); WaitForSingleObject(p, 5000); err = "no PDF within 30 s"; }
    CloseHandle(p);
    const std::string pdf = read_file(tmp);
    if (code != 0 || pdf.rfind("%PDF-", 0) != 0)
      return text(res, 500, "error: the browser printed no PDF (" + (err.empty() ? "exit code " + std::to_string(code) : err) + "): " + fs::path(S.browser).u8string() + "\n");
    if (fs::rename(tmp, out, fe); fe) return text(res, 409, "error: " + out.u8string() + " is open in another program: close the PDF and generate again\n");
    std::string fonts, fallback;
    for (const std::string& f : pdf_fonts(pdf)) {
      fonts += (fonts.empty() ? "" : ", ") + json_str(f);
      if (!kit_font(f)) fallback += (fallback.empty() ? "" : ", ") + json_str(f);
    }
    json(res, 200, "{\"pdf\": " + json_str(out.u8string()) + ", \"url\": " + json_str("http://" + req.get_header_value("Host") + "/reports/" + id + "/pdf") +
                       ", \"pages\": " + std::to_string(pdf_pages(pdf)) + ", \"bytes\": " + std::to_string(pdf.size()) + ", \"fonts\": [" + fonts +
                       "], \"fallback\": [" + fallback + "]}");
  });
  svr.Get(R"(/reports/([a-z0-9-]{1,64})/pdf)", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string id = req.matches[1];
    std::string pdf = read_file(reports / id / "report.pdf");   // read whole: no handle stays open for the next print's rename
    if (pdf.empty()) return text(res, 404, "error: no PDF of this report yet: generate it (POST /reports/{id}/pdf)\n");
    res.set_header("Content-Disposition", "inline; filename=\"" + id + ".pdf\"");
    res.set_header("Cache-Control", "no-store");
    res.set_content(std::move(pdf), "application/pdf");
  });
  // The hidden instance's record (its settings and the steps it took), in memory, for the app to pick up when it opens.
  svr.Get("/session", [&](const httplib::Request&, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(S.mcpMu);
    if (S.session.empty()) return text(res, 404, "error: no session\n");
    json(res, 200, S.session);
  });
  svr.Put("/session", [&](const httplib::Request& req, httplib::Response& res) {
    if (!is_object(req.body)) return text(res, 400, "error: the body is one JSON object\n");
    std::lock_guard<std::mutex> lock(S.mcpMu);
    S.session = req.body;
    res.status = 204;
  });
  svr.Delete("/session", [&](const httplib::Request&, httplib::Response& res) {   // picked up: the hidden instance ends too
    std::lock_guard<std::mutex> lock(S.mcpMu);
    S.session.clear();
    stop_hidden(S);
    res.status = 204;
  });

  std::thread(worker, std::ref(S)).detach();   // lives as long as the process
  std::fprintf(stderr, "daylight_server: http://localhost:%d  docs /docs  gpu %s  cache %s%s%s\n", port, S.gpu.c_str(), S.dir.u8string().c_str(),
               web.empty() ? "" : ("  web " + web).c_str(), mcp ? "  mcp /mcp" : "");
  if (!svr.listen("0.0.0.0", port)) { std::fprintf(stderr, "error: cannot listen on port %d\n", port); return 2; }
  return 0;
}
