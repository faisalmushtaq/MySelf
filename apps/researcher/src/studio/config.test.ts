import { describe, expect, it } from "vitest";
import { parseEmulators, parseFirebaseConfig } from "./config.js";

describe("the Firebase config baked into a build", () => {
  it("is used only when it names a project and a key", () => {
    expect(parseFirebaseConfig('{"apiKey":"k","projectId":"p","appId":"a"}')).toEqual({ apiKey: "k", projectId: "p", appId: "a" });
    expect(parseFirebaseConfig("")).toBeNull();
    expect(parseFirebaseConfig('{"projectId":"p"}')).toBeNull();
    expect(parseFirebaseConfig('{"apiKey":"","projectId":"p"}')).toBeNull();
    expect(parseFirebaseConfig("not json")).toBeNull();
    expect(parseFirebaseConfig("[]")).toBeNull();
  });
});

describe("the emulator setting", () => {
  it("is off unless set", () => {
    expect(parseEmulators("")).toBeNull();
  });

  it("reads the three emulators", () => {
    expect(
      parseEmulators(
        '{"auth":"http://127.0.0.1:9099","firestore":{"host":"127.0.0.1","port":8181},"functions":{"host":"localhost","port":"5001"}}',
      ),
    ).toEqual({
      auth: "http://127.0.0.1:9099",
      firestore: { host: "127.0.0.1", port: 8181 },
      functions: { host: "localhost", port: 5001 },
    });
  });

  it("refuses anything that is not on this machine, so the test sign-in can never point at a real project", () => {
    expect(parseEmulators('{"auth":"https://identitytoolkit.googleapis.com"}')).toBeNull();
    expect(parseEmulators('{"firestore":{"host":"firestore.googleapis.com","port":443}}')).toBeNull();
    expect(parseEmulators('{"auth":"http://127.0.0.1:9099","functions":{"host":"example.org","port":5001}}')).toBeNull();
  });

  it("refuses malformed values", () => {
    expect(parseEmulators("{")).toBeNull();
    expect(parseEmulators('{"firestore":{"host":"127.0.0.1","port":0}}')).toBeNull();
    expect(parseEmulators("{}")).toBeNull();
  });
});
