// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Pure helpers of the agent routes (daylight_server --mcp), header-only so agent_test.cpp checks them without a server:
// a JSON scanner for the few members POST /mcp reads (everything else passes through as raw text), the local-only gate,
// the GET /files path rule, command-line / file-URL quoting for the browser the server starts, and the page count and
// fonts of the report PDFs it prints.
#pragma once
#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------------------------------- JSON scanner
// ponytail: a scanner, not a validator (escaped keys and duplicate keys are not handled); the tab's JSON.parse validates.
inline size_t ws(const std::string& s, size_t i) {   // past spaces, tabs, CR and LF
  while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) ++i;
  return i;
}

// One past the end of the value starting at s[i], or npos when it is cut off. Brackets inside strings do not count, and
// the depth is a counter, so deep nesting cannot overflow the stack; nothing is read past the end.
inline size_t skip(const std::string& s, size_t i) {
  size_t depth = 0;
  for (; i < s.size(); ++i) {
    const char c = s[i];
    if (c == '"') {
      for (++i; i < s.size() && s[i] != '"'; ++i)
        if (s[i] == '\\') ++i;   // the escaped byte: \" \\ \uXXXX
      if (i >= s.size()) return std::string::npos;
      if (depth == 0) return i + 1;
    } else if (c == '{' || c == '[') ++depth;
    else if (c == '}' || c == ']') {
      if (depth == 0) return std::string::npos;
      if (--depth == 0) return i + 1;
    } else if (depth == 0) {   // number, true, false, null: up to the next delimiter
      size_t j = i;
      while (j < s.size() && std::string_view(",:]} \t\r\n").find(s[j]) == std::string_view::npos) ++j;
      return j == i ? std::string::npos : j;
    }
  }
  return std::string::npos;
}

// The raw token of the top-level member `key` of the object s ("" when s is no object, lacks the key or is cut off).
inline std::string member(const std::string& s, const std::string& key) {
  size_t i = ws(s, 0);
  if (i >= s.size() || s[i] != '{') return "";
  for (i = ws(s, i + 1); i < s.size() && s[i] == '"';) {
    const size_t k = skip(s, i);   // the key, quotes included
    if (k == std::string::npos) return "";
    size_t v = ws(s, k);
    if (v >= s.size() || s[v] != ':') return "";
    v = ws(s, v + 1);
    const size_t e = skip(s, v), next = e == std::string::npos ? e : ws(s, e);
    if (next >= s.size() || (s[next] != ',' && s[next] != '}')) return "";
    if (k - i - 2 == key.size() && s.compare(i + 1, key.size(), key) == 0) return s.substr(v, e - v);
    if (s[next] == '}') return "";
    i = ws(s, next + 1);
  }
  return "";
}

inline bool is_object(const std::string& s) {   // one whole {...} and nothing after it (a body passed on raw)
  const size_t i = ws(s, 0);
  return i < s.size() && s[i] == '{' && ws(s, skip(s, i)) == s.size();
}

// The raw tokens of the array s's elements, in order (none when s is no array or is cut off).
inline std::vector<std::string> elements(const std::string& s) {
  std::vector<std::string> out;
  size_t i = ws(s, 0);
  if (i >= s.size() || s[i] != '[') return out;
  for (i = ws(s, i + 1); i < s.size() && s[i] != ']';) {
    const size_t e = skip(s, i);
    if (e == std::string::npos) return {};
    out.push_back(s.substr(i, e - i));
    i = ws(s, e);
    if (i < s.size() && s[i] == ',') i = ws(s, i + 1);
    else if (i >= s.size() || s[i] != ']') return {};
  }
  return i < s.size() ? out : std::vector<std::string>{};
}

// ---------------------------------------------------------------------------------------------------- local-only gate
inline std::string lower(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

// A Host header naming this machine: localhost, 127.0.0.1 or [::1], with any port (the Vite dev server passes
// localhost:5173 on). Names that merely start like one (localhost.evil.com, 127.0.0.1.nip.io) are DNS rebinding.
inline bool local_host(const std::string& host) {
  const std::string h = lower(host);
  size_t n = h.rfind(':');
  if (n != std::string::npos && h.find(']', n) != std::string::npos) n = std::string::npos;   // a colon inside [::1]
  const std::string nm = h.substr(0, n), port = n == std::string::npos ? "" : h.substr(n + 1);
  bool portOk = n == std::string::npos || (!port.empty() && port.size() <= 5);
  for (const char c : port) portOk = portOk && std::isdigit(static_cast<unsigned char>(c));
  return portOk && (nm == "localhost" || nm == "127.0.0.1" || nm == "[::1]");
}

// The agent routes answer only to this machine: the TCP peer is loopback, Host names this machine, Origin is absent
// (Claude Code, curl) or the page's own, the browser does not call the fetch cross-site, no proxy says it forwarded the
// request (Forwarded, X-Forwarded-*, X-Real-IP, Via: a reverse proxy on this machine would make a LAN user look local; an
// SSH forward says nothing: README), and a JSON body (`jsonBody`) says so (a form or text/plain POST from another page
// needs no CORS preflight). headers: (name, value) pairs.
template <class Headers>
bool local_request(const std::string& peer, const Headers& headers, bool jsonBody) {
  std::string host, origin, site, type;
  for (const auto& [k, v] : headers) {
    const std::string n = lower(k);
    if (n == "forwarded" || n == "via" || n == "x-real-ip" || n.rfind("x-forwarded-", 0) == 0) return false;
    if (n == "host") host = v;
    else if (n == "origin") origin = v;
    else if (n == "sec-fetch-site") site = v;
    else if (n == "content-type") type = lower(v.substr(0, v.find(';')));
  }
  while (!type.empty() && type.back() == ' ') type.pop_back();
  return (peer.rfind("127.", 0) == 0 || peer == "::1") && local_host(host) && (origin.empty() || origin == "http://" + host) &&
         (site.empty() || site == "none" || site == "same-origin") && (!jsonBody || type == "application/json");
}

// ---------------------------------------------------------------------------------------------------- GET /files
// Absolute drive-letter paths only (C:\... or C:/...): no UNC share (\\host\share: opening one sends the user's NTLM
// credentials), no device path (\\?\, \\.\), no drive-relative C:x, no ':' past the drive (NTFS streams), and no control
// byte (a %00 would cut the path short of the extension checked below).
inline bool local_path(const std::string& p) {
  if (p.size() < 3 || !std::isalpha(static_cast<unsigned char>(p[0])) || p[1] != ':' || (p[2] != '\\' && p[2] != '/')) return false;
  for (size_t i = 2; i < p.size(); ++i)
    if (p[i] == ':' || static_cast<unsigned char>(p[i]) < 0x20) return false;
  return true;
}

// The Model panel's accept list (web/src/panels/ModelPanel.tsx) plus .epw: the only files GET /files hands out.
inline bool served_ext(const std::string& ext) {
  static const char* const kExt[] = {".usd", ".usda", ".usdc", ".usdz", ".glb", ".gltf", ".obj", ".mtl", ".bin",
                                     ".png", ".jpg", ".jpeg", ".webp", ".exr", ".hdr", ".epw"};
  const std::string e = lower(ext);
  for (const char* x : kExt) if (e == x) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------- browser command line
// One argument for CreateProcessW as CommandLineToArgvW reads it back: quoted; backslashes before a quote and at the end
// doubled, the quote escaped.
inline std::wstring quote(const std::wstring& a) {
  std::wstring o = L"\"";
  size_t bs = 0;
  for (const wchar_t c : a) {
    if (c == L'\\') { ++bs; continue; }
    o.append(c == L'"' ? 2 * bs + 1 : bs, L'\\');
    bs = 0;
    o += c;
  }
  o.append(2 * bs, L'\\');
  return o + L"\"";
}

// file:/// URL of an absolute path (UTF-8, \ or /): every byte outside [A-Za-z0-9/:._~-] percent-encoded, so spaces and
// non-ASCII user names survive the command line.
inline std::string file_url(const std::string& path) {
  static const char kHex[] = "0123456789ABCDEF";
  std::string u = "file:///";
  for (const unsigned char c : path) {
    if (c == '\\') u += '/';
    else if (c < 0x80 && (std::isalnum(c) || std::string("/:._~-").find(static_cast<char>(c)) != std::string::npos)) u += static_cast<char>(c);
    else { u += '%'; u += kHex[c >> 4]; u += kHex[c & 15]; }
  }
  return u;
}

// ---------------------------------------------------------------------------------------------------- printed PDF
// ponytail: text scans of Chromium's (Skia's) PDFs, which keep page and font objects out of compressed object streams; a
// PDF packing them into object streams counts 0 pages and no fonts (a PDF parser then).
inline int pdf_pages(const std::string& pdf) {   // the /Type /Page objects, not /Pages
  int n = 0;
  for (size_t i = pdf.find("/Type"); i != std::string::npos; i = pdf.find("/Type", i + 1)) {
    const size_t j = ws(pdf, i + 5);
    if (pdf.compare(j, 5, "/Page") == 0 && (j + 5 == pdf.size() || !std::isalnum(static_cast<unsigned char>(pdf[j + 5])))) ++n;
  }
  return n;
}

// The embedded fonts: each /FontName once, in order, without its subset tag (ABCDEF+Geist-Regular -> Geist-Regular).
inline std::vector<std::string> pdf_fonts(const std::string& pdf) {
  std::vector<std::string> fonts;
  for (size_t i = pdf.find("/FontName"); i != std::string::npos; i = pdf.find("/FontName", i + 1)) {
    const size_t a = ws(pdf, i + 9);
    if (a >= pdf.size() || pdf[a] != '/') continue;
    size_t b = a + 1;   // a PDF name runs to the next delimiter or space
    while (b < pdf.size() && std::string_view("/[]<>(){}% \t\r\n").find(pdf[b]) == std::string_view::npos) ++b;
    std::string f = pdf.substr(a + 1, b - a - 1);
    if (f.size() > 7 && f[6] == '+' && std::all_of(f.begin(), f.begin() + 6, [](char c) { return c >= 'A' && c <= 'Z'; })) f.erase(0, 7);
    if (!f.empty() && std::find(fonts.begin(), fonts.end(), f) == fonts.end()) fonts.push_back(f);
  }
  return fonts;
}

// kit-ui's faces (Geist, Geist Mono, Space Mono, Tektur): any other font in a report PDF is the browser's fallback for a
// glyph they lack.
inline bool kit_font(const std::string& f) {
  return f.rfind("Geist", 0) == 0 || f.rfind("SpaceMono", 0) == 0 || f.rfind("Tektur", 0) == 0;
}
