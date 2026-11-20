// Reads the numbered test strip in the compositor's output. Never writes pixels to disk.
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "screencopy.h"

static struct wl_shm *shm;
static struct wl_output *output;
static struct zwlr_screencopy_manager_v1 *screencopy;
static const char *output_name;
static struct wl_buffer *buffer;
static uint8_t *pixels;
static uint32_t width, height, stride, format, flags;
static int done;

static void fail(const char *message) {
    fprintf(stderr, "%s\n", message);
    exit(1);
}

static void geometry(void *data, struct wl_output *o, int32_t x, int32_t y,
                     int32_t w, int32_t h, int32_t subpixel,
                     const char *make, const char *model, int32_t transform) {}
static void mode(void *data, struct wl_output *o, uint32_t flags,
                 int32_t width, int32_t height, int32_t refresh) {}
static void output_done(void *data, struct wl_output *o) {}
static void scale(void *data, struct wl_output *o, int32_t value) {}
static void description(void *data, struct wl_output *o, const char *description) {}
static void name(void *data, struct wl_output *o, const char *name) {
    if (strcmp(name, output_name) == 0) output = o;
}

static const struct wl_output_listener output_events = {
    geometry, mode, output_done, scale, name, description
};

static void global(void *data, struct wl_registry *registry, uint32_t id,
                   const char *interface, uint32_t version) {
    if (strcmp(interface, "wl_shm") == 0)
        shm = wl_registry_bind(registry, id, &wl_shm_interface, 1);
    if (strcmp(interface, "wl_output") == 0 && version >= 4) {
        struct wl_output *o = wl_registry_bind(registry, id, &wl_output_interface, 4);
        wl_output_add_listener(o, &output_events, NULL);
    }
    if (strcmp(interface, "zwlr_screencopy_manager_v1") == 0)
        screencopy = wl_registry_bind(registry, id, &zwlr_screencopy_manager_v1_interface, 1);
}

static void removed(void *data, struct wl_registry *registry, uint32_t id) {}
static const struct wl_registry_listener registry_events = {global, removed};

static void frame_buffer(void *data, struct zwlr_screencopy_frame_v1 *frame,
                         uint32_t f, uint32_t w, uint32_t h, uint32_t s) {
    if (f != WL_SHM_FORMAT_XRGB8888 && f != WL_SHM_FORMAT_ARGB8888 &&
        f != WL_SHM_FORMAT_XBGR8888 && f != WL_SHM_FORMAT_ABGR8888)
        fail("Screen capture requires an 8-bit RGB output.");
    if (!buffer) {
        int fd = memfd_create("cutroom-frame-strip", MFD_CLOEXEC);
        if (fd < 0 || ftruncate(fd, (size_t)s * h) < 0)
            fail("Could not allocate a screen capture buffer.");
        pixels = mmap(NULL, (size_t)s * h, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (pixels == MAP_FAILED) fail("Could not map the screen capture buffer.");
        struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (size_t)s * h);
        buffer = wl_shm_pool_create_buffer(pool, 0, w, h, s, f);
        wl_shm_pool_destroy(pool);
        close(fd);
        width = w;
        height = h;
        stride = s;
        format = f;
    }
    if (w != width || h != height || s != stride || f != format)
        fail("Screen capture buffer changed during measurement.");
    zwlr_screencopy_frame_v1_copy(frame, buffer);
}

static void frame_flags(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t value) {
    flags = value;
}

static int frame_number(const uint32_t *row) {
    uint32_t anchor = row[width * 31 / 32];
    unsigned a = (anchor >> 16) & 255, g = (anchor >> 8) & 255, b = anchor & 255;
    if (format == WL_SHM_FORMAT_XBGR8888 || format == WL_SHM_FORMAT_ABGR8888) {
        unsigned r = b;
        b = a;
        a = r;
    }
    if (a < 150 || g > 110 || b > 110) return -1;
    int value = 0;
    for (unsigned bit = 0; bit < 15; bit++) {
        uint32_t p = row[width * (2 * bit + 1) / 32];
        unsigned sum = ((p >> 16) & 255) + ((p >> 8) & 255) + (p & 255);
        if (sum >= 570) value |= 1 << bit;
        else if (sum > 180) return -1;
    }
    return value;
}

static double clock_ms(clockid_t clock) {
    struct timespec now;
    if (clock_gettime(clock, &now)) fail("Could not read the capture clock.");
    return now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0;
}

static void ready(void *data, struct zwlr_screencopy_frame_v1 *frame,
                  uint32_t sec_high, uint32_t sec_low, uint32_t nsec) {
    double time = (((uint64_t)sec_high << 32) | sec_low) * 1000.0 + nsec / 1000000.0;
    double monotonic = clock_ms(CLOCK_MONOTONIC);
    if (time > monotonic + 10 || time < monotonic - 1000)
        fail("The compositor timestamp is outside the local monotonic clock.");
    double wall_time = clock_ms(CLOCK_REALTIME) - monotonic + time;
    int value = -1;
    unsigned y;
    for (y = 0; y < height; y++) {
        unsigned row = flags & ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT ? height - 1 - y : y;
        value = frame_number((const uint32_t *)(pixels + row * stride));
        if (value >= 0) break;
    }
    printf("%.3f %d %u\n", wall_time, value, y);
    fflush(stdout);
    done = 1;
}

static void failed(void *data, struct zwlr_screencopy_frame_v1 *frame) {
    fail("The compositor could not capture the screen region.");
}

static const struct zwlr_screencopy_frame_v1_listener frame_events = {
    .buffer = frame_buffer, .flags = frame_flags, .ready = ready, .failed = failed
};

int main(int argc, char **argv) {
    if (argc != 6) fail("Usage: screen <output> <x> <y> <width> <height>");
    output_name = argv[1];
    int x = atoi(argv[2]), y = atoi(argv[3]), w = atoi(argv[4]), h = atoi(argv[5]);
    if (x < 0 || y < 0 || w < 32 || h < 1) fail("Invalid capture region.");
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) fail("Could not connect to Wayland.");
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_events, NULL);
    if (wl_display_roundtrip(display) < 0 || wl_display_roundtrip(display) < 0 ||
        !output || !shm || !screencopy)
        fail("The named output and Wayland screencopy protocol must be available.");
    for (;;) {
        done = 0;
        struct zwlr_screencopy_frame_v1 *frame =
            zwlr_screencopy_manager_v1_capture_output_region(screencopy, 0, output, x, y, w, h);
        zwlr_screencopy_frame_v1_add_listener(frame, &frame_events, NULL);
        while (!done)
            if (wl_display_dispatch(display) < 0) fail("Wayland disconnected during capture.");
        zwlr_screencopy_frame_v1_destroy(frame);
    }
}
