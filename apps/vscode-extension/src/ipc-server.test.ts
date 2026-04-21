import { describe, it, expect, mock, afterEach } from "bun:test";
import { createIpcServer } from "./ipc-server";
import type * as http from "http";

describe("createIpcServer", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("starts on a random port", async () => {
    const onUrl = mock((_url: string) => {});
    const result = await createIpcServer(onUrl);
    server = result.server;

    expect(result.port).toBeGreaterThan(0);
  });

  it("calls onUrl for GET /open?url=...", async () => {
    const onUrl = mock((_url: string) => {});
    const result = await createIpcServer(onUrl);
    server = result.server;

    const res = await fetch(
      `http://127.0.0.1:${result.port}/open?url=${encodeURIComponent("http://localhost:3000")}`,
    );

    expect(res.status).toBe(200);
    expect(onUrl).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("returns 404 for unknown paths", async () => {
    const onUrl = mock((_url: string) => {});
    const result = await createIpcServer(onUrl);
    server = result.server;

    const res = await fetch(`http://127.0.0.1:${result.port}/other`);

    expect(res.status).toBe(404);
    expect(onUrl).not.toHaveBeenCalled();
  });

  it("returns 404 when url param is missing", async () => {
    const onUrl = mock((_url: string) => {});
    const result = await createIpcServer(onUrl);
    server = result.server;

    const res = await fetch(`http://127.0.0.1:${result.port}/open`);

    expect(res.status).toBe(404);
    expect(onUrl).not.toHaveBeenCalled();
  });

  it("handles URLs with query parameters", async () => {
    const onUrl = mock((_url: string) => {});
    const result = await createIpcServer(onUrl);
    server = result.server;

    const target = "http://localhost:3000?tab=review&id=123";
    const res = await fetch(
      `http://127.0.0.1:${result.port}/open?url=${encodeURIComponent(target)}`,
    );

    expect(res.status).toBe(200);
    expect(onUrl).toHaveBeenCalledWith(target);
  });
});
