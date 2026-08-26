import { describe, expect, it } from "vitest";
import { buildSeatVoiceStatuses } from "../../src/features/voice/voiceStatus";

describe("buildSeatVoiceStatuses", () => {
  it("maps unmuted speaking peers", () => {
    const map = buildSeatVoiceStatuses([
      { customParticipantId: "usr_a", audioEnabled: true, speaking: true },
      { customParticipantId: "usr_b", audioEnabled: true, speaking: false },
      { customParticipantId: "usr_c", audioEnabled: false, speaking: true },
    ]);
    expect(map.usr_a).toEqual({ muted: false, speaking: true });
    expect(map.usr_b).toEqual({ muted: false, speaking: false });
    expect(map.usr_c).toEqual({ muted: true, speaking: false });
  });

  it("skips blank custom ids", () => {
    const map = buildSeatVoiceStatuses([
      { customParticipantId: "  ", audioEnabled: true, speaking: true },
      { customParticipantId: "usr_ok", audioEnabled: false, speaking: false },
    ]);
    expect(Object.keys(map)).toEqual(["usr_ok"]);
  });
});
