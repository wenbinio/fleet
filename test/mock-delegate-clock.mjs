// Loaded with --import by the delegate integration test only. The parent and
// fake app-server keep real clocks, so test deadlines still detect hangs.
import fs from "node:fs";
import path from "node:path";

const directory = process.env.MOCK_DELEGATE_CLOCK;
if (directory) {
  const base = Date.now();
  let idleReads = 0;
  let acknowledged = false;
  Date.now = () => {
    const offset = Number(fs.readFileSync(path.join(directory, "offset"), "utf8"));
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")); } catch {}
    if (!acknowledged && state?.status === "awaiting-steer" && state.turns === 2) {
      // The first read initializes idleDeadline; the next is the while-condition
      // check. Only then may the parent advance time and expire that deadline.
      if (++idleReads === 2) {
        fs.writeFileSync(path.join(directory, "idle-clock-ready"), "");
        acknowledged = true;
      }
    }
    return base + offset;
  };
}
