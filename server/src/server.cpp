// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// daylight_server: the daylight CLI over HTTP, core linked in-process (OptiX needs the GPU box, so no WASM).
//   PUT  /mesh/{id}?name=   one .dmesh image, cached in RAM under the client's id (LRU by bytes)
//   POST /run               multipart: sensors / context (mesh ids), args (CLI flags verbatim), epw (file) or epw_url
//                           -> the CLI's FILE.json manifest + values_b64 (float64 [N x C]) + run_s + cache report;
//                           CLI exit 1 -> 400, exit 2 -> 500; unknown ids -> 404 {"missing": [...]}
//   GET  /proxy?url=        allowlisted weather resources (station index, EnergyPlus EPWs, PVGIS TMY) via a disk cache
//   GET  /health, GET /mesh/{id} (presence), static files from --web (the built frontend)
// One GPU: runs serialise behind a mutex. Identical requests are answered from a small response cache.
#include "cli.h"
#include "daylight.h"
#include <httplib.h>

#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <list>
#include <mutex>
#include <process.h>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;
using namespace daylight;

namespace {

struct MeshEntry { Mesh mesh; size_t bytes = 0; uint64_t used = 0; };

struct State {
  std::mutex mu;                                               // the GPU and every RAM cache below: one run at a time
  std::unordered_map<std::string, MeshEntry> meshes;           // id -> parsed mesh
  size_t meshBytes = 0, meshCap = size_t(2048) << 20;
  uint64_t tick = 0;                                           // LRU clock
  std::unordered_map<std::string, Weather> weather;            // "e:<hash of the upload>" or "u:<epw_url>" -> parsed
  std::list<std::pair<std::string, std::string>> responses;    // (request key, body), most recent first
  size_t responseBytes = 0, responseCap = size_t(256) << 20;
  std::string lastSceneKey;                                    // mirrors the core's resident scene for the cache report
  std::mutex dl;                                               // one download at a time (the .part -> file rename)
  fs::path dir;                                                // disk cache of /proxy
};

uint64_t fnv1a(const std::string& s) {
  uint64_t h = 1469598103934665603ull;
  for (unsigned char c : s) { h ^= c; h *= 1099511628211ull; }
  return h;
}
std::string hex(uint64_t v) { char b[17]; std::snprintf(b, sizeof b, "%016llx", static_cast<unsigned long long>(v)); return b; }

// Mesh names as the TS binding makes them: [A-Za-z0-9._-], else "_"; empty -> "mesh". Uniqueness per run is below.
std::string sanitise(const std::string& name) {
  std::string s;
  for (char c : name) s += (std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' || c == '-') ? c : '_';
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
bool fetch_cached(State& S, const std::string& url, fs::path& out, bool& hit, std::string& err) {
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

void text(httplib::Response& res, int status, const std::string& body) { res.status = status; res.set_content(body, "text/plain"); }
std::string json_list(const std::vector<std::string>& v) {   // ["a", "b"] for validated ids (no escaping needed)
  std::string j = "[";
  for (size_t i = 0; i < v.size(); ++i) j += (i ? ", \"" : "\"") + v[i] + "\"";
  return j + "]";
}
double secs_since(std::chrono::steady_clock::time_point t) { return std::chrono::duration<double>(std::chrono::steady_clock::now() - t).count(); }

}  // namespace

int main(int argc, char** argv) {
  int port = 8080;
  size_t maxMb = 2048;
  std::string web;
  State S;
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
    else { std::fprintf(stderr, "usage: daylight_server [--port 8080] [--web DIR] [--cache DIR] [--max-mb 2048] [--mesh-cache-mb 2048]\n"); return 1; }
  }
  std::error_code ec;
  fs::create_directories(S.dir, ec);

  httplib::Server svr;
  svr.set_payload_max_length(maxMb << 20);
  if (!web.empty() && !svr.set_mount_point("/", web)) { std::fprintf(stderr, "error: --web %s is not a directory\n", web.c_str()); return 1; }
  svr.set_logger([](const httplib::Request& req, const httplib::Response& res) {
    std::fprintf(stderr, "%s %s -> %d\n", req.method.c_str(), req.path.c_str(), res.status);
  });

  svr.Get("/health", [](const httplib::Request&, httplib::Response& res) { text(res, 200, "ok"); });

  svr.Get(R"(/mesh/([A-Za-z0-9-]{1,64}))", [&](const httplib::Request& req, httplib::Response& res) {
    std::lock_guard<std::mutex> lock(S.mu);
    res.status = S.meshes.count(req.matches[1]) ? 204 : 404;
  });

  svr.Put(R"(/mesh/([A-Za-z0-9-]{1,64}))", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string id = req.matches[1];
    const std::string name = sanitise(req.has_param("name") ? req.get_param_value("name") : id);
    std::vector<Mesh> ms;
    std::string err;
    if (!read_dmesh(req.body.data(), req.body.size(), name, ms, err)) return text(res, 400, "error: " + err);
    if (ms.empty()) return text(res, 400, "error: " + name + ": mesh has no faces");
    std::lock_guard<std::mutex> lock(S.mu);
    if (auto it = S.meshes.find(id); it != S.meshes.end()) { S.meshBytes -= it->second.bytes; S.meshes.erase(it); }
    // ponytail: RAM LRU, meshes come back after a restart with one PUT round trip; a disk cache if that ever hurts
    while (S.meshBytes + req.body.size() > S.meshCap && !S.meshes.empty()) {
      auto oldest = S.meshes.begin();
      for (auto j = S.meshes.begin(); j != S.meshes.end(); ++j) if (j->second.used < oldest->second.used) oldest = j;
      S.meshBytes -= oldest->second.bytes;
      S.meshes.erase(oldest);
    }
    S.meshBytes += req.body.size();
    S.meshes[id] = MeshEntry{std::move(ms[0]), req.body.size(), ++S.tick};
    res.status = 204;
  });

  svr.Get("/proxy", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string url = req.get_param_value("url");
    if (!allowed(url)) return text(res, 400, "error: url not in the allowlist");
    fs::path p;
    bool hit = false;
    std::string err;
    if (!fetch_cached(S, url, p, hit, err)) return text(res, 502, "error: " + err);
    res.set_header("Cache-Control", "max-age=86400");
    res.set_header("X-Daylight-Cache", hit ? "hit" : "miss");
    res.set_content(read_file(p), url.find(".geojson") != std::string::npos ? "application/geo+json" : "text/plain");
  });

  svr.Post("/run", [&](const httplib::Request& req, httplib::Response& res) {
    const auto t0 = std::chrono::steady_clock::now();
    const std::vector<std::string> sensors = req.form.get_fields("sensors"), context = req.form.get_fields("context"), args = req.form.get_fields("args");
    const std::string epwUrl = req.form.get_field("epw_url");
    const bool epwPart = req.form.has_file("epw");
    if (sensors.empty()) return text(res, 400, "error: no sensor meshes (sensors fields with mesh ids)");
    for (const auto& id : sensors) if (!valid_id(id)) return text(res, 400, "error: bad mesh id");
    for (const auto& id : context) if (!valid_id(id)) return text(res, 400, "error: bad mesh id");
    for (const auto& id : context) for (const auto& s : sensors) if (id == s) return text(res, 400, "error: mesh " + id + " is both sensor and context");
    if (epwPart && !epwUrl.empty()) return text(res, 400, "error: give epw or epw_url, not both");
    if (!epwUrl.empty() && !allowed(epwUrl)) return text(res, 400, "error: epw_url not in the allowlist");
    const std::string epwText = epwPart ? req.form.get_file("epw").content : std::string();
    const std::string weatherKey = epwPart ? "e:" + hex(fnv1a(epwText)) : epwUrl.empty() ? std::string() : "u:" + epwUrl;

    std::lock_guard<std::mutex> lock(S.mu);
    // identical request -> stored body (its cache report said "miss" when it was made)
    std::string key = weatherKey + "\n";
    for (const auto& s : sensors) key += "s:" + s + "\n";
    for (const auto& s : context) key += "c:" + s + "\n";
    for (const auto& a : args) key += "a:" + a + "\n";
    for (auto it = S.responses.begin(); it != S.responses.end(); ++it)
      if (it->first == key) {
        S.responses.splice(S.responses.begin(), S.responses, it);
        std::string body = it->second;
        if (const size_t p = body.rfind("\"response\": \"miss\""); p != std::string::npos) body.replace(p, 18, "\"response\": \"hit\"");
        res.set_content(body, "application/json");
        return;
      }
    std::vector<std::string> missing;
    for (const auto& id : sensors) if (!S.meshes.count(id)) missing.push_back(id);
    for (const auto& id : context) if (!S.meshes.count(id)) missing.push_back(id);
    if (!missing.empty()) { res.status = 404; res.set_content("{\"missing\": " + json_list(missing) + "}", "application/json"); return; }

    // the CLI's parser on the args, then the HTTP-only rules
    std::vector<std::string> argvS = {"daylight"};
    argvS.insert(argvS.end(), args.begin(), args.end());
    std::vector<char*> av;
    for (auto& s : argvS) av.push_back(s.data());
    cli::Args a;
    std::string err;
    if (cli::parse(static_cast<int>(av.size()), av.data(), a, err)) return text(res, 400, "error: " + err + "\n" + cli::kUsage);
    if (a.help) return text(res, 200, cli::kUsage);
    if (!a.sensors.empty() || !a.context.empty())
      return text(res, 400, "error: mesh files are not available over HTTP; PUT /mesh/{id} and name the ids in the sensors / context fields");
    if (!a.epw.empty() || a.clearSky && (epwPart || !epwUrl.empty()))
      return text(res, 400, "error: weather comes from the epw part, epw_url or --clear-sky, one of them");
    if (!a.out.empty() || a.bench || !a.opt.seriesPath.empty() || !a.opt.dumpBitsPath.empty() || !a.opt.dumpSky.empty() || !a.opt.dumpSun.empty())
      return text(res, 400, "error: --out, --timeseries, --dump-* and --bench are not available over HTTP");

    // weather: parsed-Weather cache, else the upload or the proxy cache
    Weather weather;
    bool haveWeather = false;
    const char* weatherCache = "none";
    if (!weatherKey.empty()) {
      if (auto w = S.weather.find(weatherKey); w != S.weather.end()) { weather = w->second; weatherCache = "hit"; }
      else {
        std::string textEpw = epwText, label = epwPart ? req.form.get_file("epw").filename : epwUrl;
        if (!epwPart) {
          fs::path p;
          bool hit = false;
          if (!fetch_cached(S, epwUrl, p, hit, err)) return text(res, 502, "error: " + err);
          textEpw = read_file(p);
        }
        std::istringstream in(textEpw);
        if (!read_epw(in, label, weather, err)) return text(res, 400, "error: " + err);
        S.weather[weatherKey] = weather;
        weatherCache = "miss";
      }
      haveWeather = true;
    }
    if (const int rc = cli::prepare(a, weather, haveWeather, err)) return text(res, rc == 1 ? 400 : 500, "error: " + err);

    // meshes from the cache (names made unique per run as the TS binding does), scene key for the resident GAS
    // ponytail: run() takes meshes by value, so each run copies the cached arrays (~10 ms per 44 MB); a pointer
    // overload of run() in the core if that ever shows up in run_s
    std::vector<Mesh> meshes;
    std::string sceneKey;
    std::unordered_map<std::string, int> seen;
    auto take = [&](const std::string& id, bool sensor) {
      MeshEntry& e = S.meshes.at(id);
      e.used = ++S.tick;
      Mesh m = e.mesh;
      m.sensor = sensor;
      std::string lower = m.name;
      for (char& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      if (const int n = seen[lower]++) m.name += "_" + std::to_string(n + 1);
      meshes.push_back(std::move(m));
      sceneKey += (sensor ? "s:" : "c:") + id + "\n";
    };
    for (const auto& id : sensors) take(id, true);
    for (const auto& id : context) take(id, false);
    a.opt.sceneKey = sceneKey + (a.opt.selfOcclude ? "self" : "noself");
    const char* scene = S.lastSceneKey == a.opt.sceneKey ? "reused" : "built";

    Result r;
    const auto t1 = std::chrono::steady_clock::now();
    if (!run(meshes, haveWeather ? &weather : nullptr, a.opt, r, err)) { S.lastSceneKey.clear(); return text(res, 500, "error: " + err); }
    S.lastSceneKey = a.opt.sceneKey;
    const double runS = secs_since(t1);

    const std::string b64 = httplib::detail::base64_encode(std::string(reinterpret_cast<const char*>(r.values.data()), r.values.size() * sizeof(double)));
    char tail[256];
    std::snprintf(tail, sizeof tail, "\",\n  \"run_s\": %.3f,\n  \"total_s\": %.3f,\n  \"cache\": {\"response\": \"miss\", \"scene\": \"%s\", \"weather\": \"%s\"}",
                  runS, secs_since(t0), scene, weatherCache);
    const std::string body = cli::manifest_json(r, "\"values_b64\": \"" + b64 + tail);
    S.responses.emplace_front(key, body);
    S.responseBytes += body.size();
    while (S.responseBytes > S.responseCap && S.responses.size() > 1) { S.responseBytes -= S.responses.back().second.size(); S.responses.pop_back(); }
    res.set_content(body, "application/json");
  });

  std::fprintf(stderr, "daylight_server: http://localhost:%d  cache %s%s\n", port, S.dir.string().c_str(), web.empty() ? "" : ("  web " + web).c_str());
  if (!svr.listen("0.0.0.0", port)) { std::fprintf(stderr, "error: cannot listen on port %d\n", port); return 2; }
  return 0;
}
