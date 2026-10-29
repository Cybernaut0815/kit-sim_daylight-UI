cmake_minimum_required(VERSION 3.27)
project(daylight_server LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")   # same as the core: cudart_static is /MT, we are /MD

# cpp-httplib (MIT), header-only. GIT_REPOSITORY, not a tarball URL: the bundled CMake lacks CA certificates.
include(FetchContent)
FetchContent_Declare(httplib GIT_REPOSITORY https://github.com/yhirose/cpp-httplib GIT_TAG v0.60.1 GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(httplib)

# The simulation core: the kit-sim_daylight submodule, linked in-process (its CMake also registers its ctest checks).
add_subdirectory(../kit-sim_daylight kit-sim_daylight)

# The API description served at /openapi.json, the agent guide at /llms.txt and the MCP tools and instructions
# (mcp.json, answered by POST /mcp), embedded so the exe stays one file.
set(GEN "${CMAKE_CURRENT_BINARY_DIR}/gen")
foreach(doc openapi.json llms.txt mcp.json)
  string(REPLACE "." "_" var "${doc}")
  add_custom_command(OUTPUT "${GEN}/${var}.h"
    COMMAND "${CMAKE_COMMAND}" -DIN=${CMAKE_CURRENT_SOURCE_DIR}/${doc} -DOUT=${GEN}/${var}.h -DNAME=${var} -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake"
    DEPENDS "${doc}" cmake/embed.cmake
    COMMENT "embed ${doc}" VERBATIM)
  list(APPEND EMBEDDED "${GEN}/${var}.h")
endforeach()

add_executable(daylight_server src/server.cpp ${EMBEDDED})
target_include_directories(daylight_server PRIVATE "${GEN}")
target_link_libraries(daylight_server PRIVATE daylightcore httplib::httplib ws2_32 advapi32)   # advapi32: the browser's App Paths entry
target_compile_definitions(daylight_server PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(daylight_server PRIVATE /W4 /WX /permissive- /utf-8 /EHsc /external:anglebrackets /external:W0)
target_link_options(daylight_server PRIVATE /NODEFAULTLIB:libcmt)

# The spec matches the routes in server.cpp and documents every operation (needs Node on the PATH).
enable_testing()
find_program(NODE node)
if(NODE)
  add_test(NAME openapi_drift COMMAND "${NODE}" "${CMAKE_CURRENT_SOURCE_DIR}/check_openapi.mjs")
endif()

# The agent routes' pure helpers (src/agent.h: JSON scanner, local-only gate, /files path rule, quoting).
add_executable(agent_test src/agent_test.cpp)
target_compile_options(agent_test PRIVATE /W4 /WX /permissive- /utf-8 /EHsc)
add_test(NAME agent_helpers COMMAND agent_test)
