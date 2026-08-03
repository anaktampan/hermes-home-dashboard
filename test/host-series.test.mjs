import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_SIGNALS,
  pushSample,
  seriesOf,
  seriesPath,
  signalMax,
  toSample,
} from "../src/home/widgets/hostSeries.ts";

const MB = 1024 ** 2;

const fullStats = {
  os: "Linux", os_release: "6.8", os_version: "x", platform: "Linux-x86_64",
  arch: "x86_64", hostname: "vps", python_version: "3.11", python_impl: "CPython",
  hermes_version: "0.19.1", cpu_count: 8, psutil: true,
  cpu_percent: 34.4,
  load_avg: [1.24, 0.9, 0.7],
  memory: { total: 100, available: 22, used: 78, percent: 78.2 },
  disk: { total: 100, used: 60, free: 40, percent: 60 },
  process: { pid: 1, rss: 293 * MB, create_time: 0, num_threads: 31 },
};

test("toSample extracts the four live signals from system stats", () => {
  const s = toSample(fullStats, 1000);
  assert.equal(s.t, 1000);
  assert.equal(s.cpu, 34.4);
  assert.equal(s.ram, 78.2);
  assert.equal(s.load, 1.24);
  assert.equal(s.proc, 293 * MB);
});

test("toSample marks missing sources as null instead of throwing", () => {
  const bare = {
    os: "Linux", os_release: "6.8", os_version: "x", platform: "p",
    arch: "x86_64", hostname: "vps", python_version: "3.11",
    python_impl: "CPython", hermes_version: "0.19.1",
    cpu_count: null, psutil: false,
  };
  const s = toSample(bare, 5);
  assert.equal(s.cpu, null);
  assert.equal(s.ram, null);
  assert.equal(s.load, null);
  assert.equal(s.proc, null);
});

test("pushSample appends and trims the buffer to its cap", () => {
  let buf = [];
  for (let i = 0; i < 5; i++) {
    buf = pushSample(buf, toSample(fullStats, i), 3);
  }
  assert.equal(buf.length, 3);
  assert.deepEqual(buf.map((s) => s.t), [2, 3, 4]);
});

test("pushSample returns a new array and leaves the input untouched", () => {
  const original = [toSample(fullStats, 1)];
  const next = pushSample(original, toSample(fullStats, 2), 10);
  assert.notEqual(next, original);
  assert.equal(original.length, 1);
  assert.equal(next.length, 2);
});

test("seriesOf pulls one signal's values in buffer order", () => {
  const buf = [
    { t: 1, cpu: 10, ram: 50, load: 1, proc: 100 },
    { t: 2, cpu: 20, ram: 60, load: 2, proc: 200 },
  ];
  assert.deepEqual(seriesOf(buf, "cpu"), [10, 20]);
  assert.deepEqual(seriesOf(buf, "proc"), [100, 200]);
});

test("signalMax uses the fixed scale when the signal has one", () => {
  const cpu = HOST_SIGNALS.find((s) => s.key === "cpu");
  assert.equal(signalMax([10, 40], cpu.fixedMax), 100);
});

test("signalMax autoscales to the window peak when no fixed scale", () => {
  assert.equal(signalMax([1.5, 4.2, 3.3], undefined), 4.2);
});

test("signalMax never returns a non-positive scale", () => {
  assert.ok(signalMax([], undefined) > 0);
  assert.ok(signalMax([0, 0], undefined) > 0);
});

test("seriesPath draws a scaled M/L polyline inside the padded viewbox", () => {
  // Two points, fixed 0-100 scale, 100x100 box with 3px pad: first point at
  // x=0, last at x=100; value 0 sits at y=97, value 100 at y=3.
  const d = seriesPath([0, 100], 100, 100, 100, 3);
  assert.equal(d, "M0.00,97.00 L100.00,3.00");
});

test("seriesPath skips null gaps without connecting across them", () => {
  const d = seriesPath([0, null, 100], 100, 100, 100, 3);
  // Three slots: x = 0, 50, 100. The null middle breaks the line into two
  // single-point segments (M without a following L).
  assert.equal(d, "M0.00,97.00 M100.00,3.00");
});

test("seriesPath centers a single point and returns empty for none", () => {
  assert.equal(seriesPath([50], 100, 100, 100, 3), "M50.00,50.00");
  assert.equal(seriesPath([], 100, 100, 100, 3), "");
});

test("HOST_SIGNALS declares the four graphs with their formatters", () => {
  assert.deepEqual(HOST_SIGNALS.map((s) => s.key), ["cpu", "ram", "load", "proc"]);
  const by = Object.fromEntries(HOST_SIGNALS.map((s) => [s.key, s]));
  assert.equal(by.cpu.format(34.4), "34%");
  assert.equal(by.ram.format(78.2), "78%");
  assert.equal(by.load.format(1.239), "1.24");
  assert.equal(by.proc.format(293 * MB), "293M");
  assert.equal(by.cpu.fixedMax, 100);
  assert.equal(by.ram.fixedMax, 100);
  assert.equal(by.load.fixedMax, undefined);
  assert.equal(by.proc.fixedMax, undefined);
});

test("the rolling buffer spans at least a one-minute window", async () => {
  const { SAMPLE_MS, BUFFER_CAP } = await import("../src/home/widgets/hostSeries.ts");
  assert.ok((BUFFER_CAP - 1) * SAMPLE_MS >= 60_000, "window shorter than 60s");
  assert.ok(SAMPLE_MS <= 5_000, "sampling too coarse to feel live");
});

test("coerceHostView keeps legacy values and accepts graphs", async () => {
  const { coerceHostView } = await import("../src/home/widgets/hostSeries.ts");
  assert.equal(coerceHostView("meters"), "meters");
  assert.equal(coerceHostView("detail"), "detail");
  assert.equal(coerceHostView("graphs"), "graphs");
  assert.equal(coerceHostView(undefined), "meters");
  assert.equal(coerceHostView("bogus"), "meters");
});

test("areaPath closes a contiguous line down to the floor", async () => {
  const { areaPath } = await import("../src/home/widgets/hostSeries.ts");
  const line = "M0.00,97.00 L100.00,3.00";
  assert.equal(areaPath(line, 100), "M0.00,97.00 L100.00,3.00 L100.00,100 L0.00,100 Z");
});

test("areaPath refuses gappy or degenerate lines", async () => {
  const { areaPath } = await import("../src/home/widgets/hostSeries.ts");
  assert.equal(areaPath("M0.00,97.00 M100.00,3.00", 100), "");
  assert.equal(areaPath("M50.00,50.00", 100), "");
  assert.equal(areaPath("", 100), "");
});
