const { hashSessionToken, readBearerToken, isSessionActive } = require("./session-utils");

describe("server-issued session helpers", () => {
  test("hashes bearer tokens without storing the raw token", () => {
    const token = "a".repeat(64);
    expect(hashSessionToken(token)).toHaveLength(64);
    expect(hashSessionToken(token)).not.toBe(token);
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  test("accepts only a well-formed bearer token", () => {
    expect(readBearerToken({ authorization: "Bearer " + "b".repeat(64) })).toBe("b".repeat(64));
    expect(readBearerToken({ authorization: "Basic " + "b".repeat(64) })).toBe("");
    expect(readBearerToken({ authorization: "Bearer short" })).toBe("");
  });

  test("rejects missing and expired sessions", () => {
    expect(isSessionActive(null, 100)).toBe(false);
    expect(isSessionActive({ expiresAt: 99 }, 100)).toBe(false);
    expect(isSessionActive({ expiresAt: 101 }, 100)).toBe(true);
  });
});
