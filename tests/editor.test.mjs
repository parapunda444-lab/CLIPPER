import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTime,
  timeLabel,
  parseSrt,
  toSrt,
  bestSixty,
  selectClip,
  newProject,
  validYoutubeUrl,
} from "../src/lib/editor.ts";
test("timestamps are validated and formatted", () => {
  assert.equal(parseTime("01:05.5"), 65.5);
  assert.equal(parseTime("1:02:03"), 3723);
  assert.equal(parseTime("00:60"), null);
  assert.equal(parseTime("-4"), null);
  assert.equal(timeLabel(65), "01:05");
});
test("SRT parsing preserves multiline text and clips to the video", () => {
  const result = parseSrt(
    "1\r\n00:00:01,250 --> 00:00:04,000\r\nHello\r\nworld\r\n\r\n2\r\n00:00:05,000 --> 00:00:09,000\r\nGoodbye",
    7,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "Hello\nworld");
  assert.equal(result[1].end, 7);
  assert.match(toSrt(result, 2, 6), /00:00:00,000 --> 00:00:02,000/);
  assert.match(toSrt(result, 2, 6), /00:00:03,000 --> 00:00:04,000/);
});
test("SRT rejects bad ranges, accepts VTT and strips markup", () => {
  assert.throws(() => parseSrt("00:00:04,000 --> 00:00:01,000\nBad", 8));
  assert.equal(
    parseSrt("WEBVTT\n\n00:01.000 --> 00:03.500\n<b>Hello</b>", 10)[0].text,
    "Hello",
  );
});
test("auto clip stays exactly 60 seconds near video end and uses full shorter source", () => {
  const clip = {
    id: "a",
    start: 95,
    end: 110,
    score: 93,
    title: "A",
    description: "",
    tags: [],
  };
  assert.deepEqual(
    [bestSixty([clip], 120).start, bestSixty([clip], 120).end],
    [60, 120],
  );
  assert.deepEqual(
    [bestSixty([clip], 30).start, bestSixty([clip], 30).end],
    [0, 30],
  );
  assert.equal(bestSixty([], 30), null);
});
test("clip selection clamps boundaries and enables portrait captions", () => {
  const p = newProject({ id: "v", url: "/v", name: "v.mp4", duration: 90 });
  const next = selectClip(p, { id: "a", start: -2, end: 300, score: 92 });
  assert.equal(next.settings.start, 0);
  assert.equal(next.settings.end, 90);
  assert.equal(next.settings.aspect, "9:16");
  assert.equal(next.settings.showCaptions, true);
});
test("YouTube URL checks reject foreign hosts and malformed input", () => {
  assert.equal(
    validYoutubeUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    true,
  );
  assert.equal(validYoutubeUrl("https://youtu.be/jNQXAC9IVRw"), true);
  assert.equal(
    validYoutubeUrl("https://youtube.com.evil.test/watch?v=x"),
    false,
  );
  assert.equal(validYoutubeUrl("file:///etc/passwd"), false);
});

test("YouTube URL checks match supported mobile, Shorts and short-link forms", () => {
  for (const url of [
    "https://m.youtube.com/watch?v=jNQXAC9IVRw",
    "https://youtu.be/jNQXAC9IVRw/",
    "https://www.youtube.com/shorts/jNQXAC9IVRw/",
  ])
    assert.equal(validYoutubeUrl(url), true, url);
  for (const url of [
    "https://youtu.be/jNQXAC9IVRw?list=PL123",
    "https://youtube.com/watch?v=jNQXAC9IVRw&v=jNQXAC9IVRw",
    "https://youtube.com:444/watch?v=jNQXAC9IVRw",
  ])
    assert.equal(validYoutubeUrl(url), false, url);
});
