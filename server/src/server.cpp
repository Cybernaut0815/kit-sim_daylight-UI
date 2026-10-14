// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// daylight_server: the daylight CLI over HTTP for several users at once, core linked in-process (OptiX needs the GPU
// box, so no WASM). One worker thread owns the GPU and runs queued jobs one after another; everything else (uploads,
// validation, cached answers, status polls, weather downloads) runs on the HTTP thread pool and never waits for it.
// The API is self-describing: GET /openapi.json (OpenAPI 3.1, embedded from server/openapi.json), /docs (Swagger UI),
// /redoc (ReDoc) and /llms.txt (a plain-text guide for agents).
#include "cli.h"
#include "daylight.h"
#include <httplib.h>
#include <cuda_runtime.h>

#include "llms_txt.h"
#include "openapi_json.h"

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
    const bool reused = scene_resident(opt.sceneKey);
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
                    runS, double(std::time(nullptr) - j->created), reused ? "reused" : "built", j->weatherCache.c_str());
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
  Server S;
  const char* local = std::getenv("LOCALAPPDATA");
  S.dir = fs::path(local ? local : ".") / "daylight_server";
  for (int i = 1; i < argc; ++i) {
    const std::string f = argv[i];
    auto val = [&]() -> const char* { return i + 1 < argc ? argv[++i] : ""; };
    if (f == "--port") port = std::atoi(val());
    else if (f == "--web") web = val();
    else if (f == "--cache") S.dir = val();
    else if (f == "--max-mb") maxMb = static_cast<size_t>(std::atoll(val()));
    else if (f == "--mesh-cache-mb") S.meshCap = static_cast<size_t>(std::atoll(val())) << 20;
    else if (f == "--client-jobs") S.clientJobs = std::max(1, std::atoi(val()));
    else if (f == "--max-queue") S.maxQueue = std::max(1, std::atoi(val()));
    else if (f == "--job-ttl-min") S.ttlMin = std::max(1, std::atoi(val()));
    else if (f == "--gpu-scenes") S.gpuScenes = std::max(1, std::atoi(val()));
    else {
      std::fprintf(stderr, "usage: daylight_server [--port 8080] [--web DIR] [--cache DIR] [--max-mb 2048] [--mesh-cache-mb 2048]\n"
                           "                       [--client-jobs 2] [--max-queue 32] [--job-ttl-min 15] [--gpu-scenes 4]\n");
      return 1;
    }
  }
  std::error_code ec;
  fs::create_directories(S.dir, ec);
  if (cudaDeviceProp p{}; cudaGetDeviceProperties(&p, 0) == cudaSuccess) S.gpu = p.name;

  httplib::Server svr;
  svr.new_task_queue = [] { return new httplib::ThreadPool(16, 128); };   // long polls and waiting /run calls never starve uploads
  svr.set_payload_max_length(maxMb << 20);
  if (!web.empty() && !svr.set_mount_point("/", web)) { std::fprintf(stderr, "error: --web %s is not a directory\n", web.c_str()); return 1; }
  svr.set_logger([](const httplib::Request& req, const httplib::Response& res) {
    std::fprintf(stderr, "%s %s -> %d\n", req.method.c_str(), req.path.c_str(), res.status);
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

  std::thread(worker, std::ref(S)).detach();   // lives as long as the process
  std::fprintf(stderr, "daylight_server: http://localhost:%d  docs /docs  gpu %s  cache %s%s\n", port, S.gpu.c_str(), S.dir.string().c_str(),
               web.empty() ? "" : ("  web " + web).c_str());
  if (!svr.listen("0.0.0.0", port)) { std::fprintf(stderr, "error: cannot listen on port %d\n", port); return 2; }
  return 0;
}
