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

add_executable(daylight_server src/server.cpp)
target_link_libraries(daylight_server PRIVATE daylightcore httplib::httplib ws2_32)
target_compile_definitions(daylight_server PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(daylight_server PRIVATE /W4 /WX /permissive- /utf-8 /EHsc /external:anglebrackets /external:W0)
target_link_options(daylight_server PRIVATE /NODEFAULTLIB:libcmt)
