// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Assert-style checks of agent.h (the agent routes' scanner, gate, path rule, quoting and PDF scans), run by ctest as
// agent_helpers.
#include "agent.h"

#include <cstdio>
#include <string>
#include <utility>
#include <vector>

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("%s:%d: CHECK(%s)\n", __FILE__, __LINE__, #cond); ++failures; } } while (0)

using Hdrs = std::vector<std::pair<std::string, std::string>>;

int main() {
  // ---- scanner: raw tokens, top level only, escapes, truncation, deep nesting
  const std::string req = "{\"jsonrpc\":\"2.0\",\r\n\t\"params\": {\"name\": \"x\", \"method\": \"evil\", \"a\": [1, {\"b\": \"]}\"}]},"
                          " \"note\": \"\\\"method\\\": 1\", \"id\": \"a\\\"b\", \"method\" : \"tools/call\" }";
  CHECK(member(req, "method") == "\"tools/call\"");           // not the nested one, not the one inside a string
  CHECK(member(req, "id") == "\"a\\\"b\"");                   // string id kept raw, escapes included
  CHECK(member(member(req, "params"), "name") == "\"x\"");
  CHECK(member(member(req, "params"), "a") == "[1, {\"b\": \"]}\"}]");
  CHECK(member(req, "missing").empty());
  CHECK(member("{\"id\": 12, \"method\": \"ping\"}", "id") == "12");
  CHECK(member("{\"id\":-1.5e3}", "id") == "-1.5e3");
  CHECK(member("{\"a\": \"x\\\\\", \"id\": null}", "id") == "null");   // "x\\" ends at its second quote
  CHECK(member("{\"method\":\"pi", "method").empty());        // cut off inside a string
  CHECK(member("{\"id\": 12", "id").empty());                 // cut off after a bare token
  CHECK(member("{\"a\": \"x\\", "a").empty());                // a backslash as the last byte
  CHECK(member("[{\"method\": \"ping\"}]", "method").empty()); // a batch is no object
  CHECK(member("", "id").empty() && member("{}", "id").empty());
  const std::string deep(100000, '[');
  CHECK(skip(deep, 0) == std::string::npos);
  CHECK(skip(deep + std::string(100000, ']'), 0) == 200000);
  CHECK(member("{\"a\": " + deep, "a").empty());
  CHECK(skip("}", 0) == std::string::npos && skip(",", 0) == std::string::npos && skip("true]", 0) == 4);
  CHECK(is_object(" {\"content\": [], \"isError\": true}\n") && is_object("{}"));
  CHECK(!is_object("{\"a\": 1") && !is_object("{} x") && !is_object("[]") && !is_object(""));

  // ---- local_request: who may use the agent routes
  auto ok = [](const std::string& peer, const Hdrs& h, bool json = false) { return local_request(peer, h, json); };
  CHECK(ok("127.0.0.1", {{"Host", "localhost:5173"}, {"Origin", "http://localhost:5173"}, {"Sec-Fetch-Site", "same-origin"}}));
  CHECK(ok("127.0.0.1", {{"Host", "127.0.0.1:8080"}}));
  CHECK(ok("::1", {{"host", "[::1]:8080"}}));
  CHECK(ok("127.0.0.1", {{"Host", "LOCALHOST"}, {"Sec-Fetch-Site", "none"}}));
  CHECK(ok("127.0.0.1", {{"Host", "localhost:8080"}, {"Content-Type", "application/json; charset=utf-8"}}, true));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost.evil.com"}}));
  CHECK(!ok("127.0.0.1", {{"Host", "127.0.0.1.nip.io:8080"}}));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:"}}) && !ok("127.0.0.1", {{"Host", "localhost:80a"}}));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}, {"Origin", "null"}}));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}, {"Origin", "http://evil.com"}}));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}, {"Origin", "http://localhost:3000"}}));   // another local site
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}, {"Sec-Fetch-Site", "cross-site"}}));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}, {"Sec-Fetch-Site", "same-site"}}));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}, {"X-Forwarded-For", "192.168.1.20"}}));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}, {"Forwarded", "for=192.168.1.20"}}));
  CHECK(!ok("192.168.1.20", {{"Host", "localhost:8080"}}));   // a LAN peer
  CHECK(!ok("127.0.0.1", {}) && !ok("127.0.0.1", {{"Host", ""}}));
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}}, true));   // a JSON route without Content-Type
  CHECK(!ok("127.0.0.1", {{"Host", "localhost:8080"}, {"Content-Type", "text/plain"}}, true));

  // ---- GET /files path rule and file types
  CHECK(local_path("C:\\models\\house.usdz") && local_path("d:/m/x.obj"));
  CHECK(!local_path("\\\\server\\share\\x.usdz") && !local_path("//server/share/x.usdz"));   // UNC
  CHECK(!local_path("\\\\?\\C:\\x.usdz") && !local_path("\\\\.\\PhysicalDrive0"));           // device paths
  CHECK(!local_path("C:x.usd") && !local_path("models\\x.usd") && !local_path("") && !local_path("C:"));
  CHECK(!local_path("C:\\secret.txt:x.usd"));                                                 // an NTFS stream
  CHECK(!local_path(std::string("C:\\secret.txt\0.usd", 18)));                                // %00
  CHECK(served_ext(".usdz") && served_ext(".EPW") && served_ext(".jpeg") && !served_ext(".txt") && !served_ext(""));

  // ---- command line and file URL for the browser
  CHECK(quote(L"C:\\Program Files\\x\\chrome.exe") == L"\"C:\\Program Files\\x\\chrome.exe\"");
  CHECK(quote(L"C:\\dir\\") == L"\"C:\\dir\\\\\"");   // a trailing backslash would escape the closing quote
  CHECK(quote(L"a\\\"b") == L"\"a\\\\\\\"b\"");       // a\"b: the backslash doubled, the quote escaped
  CHECK(quote(L"") == L"\"\"");
  CHECK(file_url("C:\\Users\\J\xC3\xBCrgen\\a b\\index.html") == "file:///C:/Users/J%C3%BCrgen/a%20b/index.html");
  CHECK(file_url("C:/x/r#1%.html") == "file:///C:/x/r%231%25.html");

  // ---- printed PDF: pages and fonts (shaped as Chromium writes them)
  const std::string pdf = "%PDF-1.4\n1 0 obj\n<</Type /Pages /Count 2 /Kids [2 0 R 3 0 R]>>\nendobj\n2 0 obj\n<</Type /Page /Parent 1 0 R>>\n"
                          "3 0 obj\n<</Type/Page/Parent 1 0 R>>\n4 0 obj\n<</Type /FontDescriptor /FontName /AAAAAA+Geist-Regular /Flags 4>>\n"
                          "5 0 obj\n<</FontName /BCDEFG+SegoeUI>>\n6 0 obj\n<</FontName /Geist-Regular>>\n7 0 obj\n<</FontName/SpaceMono-Bold/Flags 4>>";
  CHECK(pdf_pages(pdf) == 2);   // /Type /Pages is the page tree, not a page
  CHECK(pdf_pages("") == 0 && pdf_pages("/Type") == 0 && pdf_pages("/Type /Page") == 1 && pdf_pages("/Subtype /Type0 /Page") == 0);
  CHECK((pdf_fonts(pdf) == std::vector<std::string>{"Geist-Regular", "SegoeUI", "SpaceMono-Bold"}));   // subset tags dropped, once each
  CHECK(pdf_fonts("/FontName").empty() && pdf_fonts("/FontName (x)").empty() && pdf_fonts("/FontName /abcdef+X") == std::vector<std::string>{"abcdef+X"});
  CHECK(kit_font("Geist-Regular") && kit_font("GeistMono-Regular") && kit_font("SpaceMono-Bold") && kit_font("Tektur-SemiBold"));
  CHECK(!kit_font("SegoeUI") && !kit_font("ArialMT") && !kit_font(""));   // a fallback face

  std::printf("%s: %d failure(s)\n", failures ? "FAIL" : "OK", failures);
  return failures ? 1 : 0;
}
