import { Z80Cpu } from "@dcorp80/z80cpu";
import { describe, expect, it } from "vitest";
import { type BusConfig, DEFAULT_BUS_CONFIG } from "../config/defaults.ts";
import { IO_SIZE, MEM_SIZE, makeBus64k } from "./bus.ts";

function freshBus(overrides: Partial<BusConfig> = {}) {
  // Pin splitIo to false here so the bulk of the suite tests the joined
  // path even when the shipped `DEFAULT_BUS_CONFIG.splitIo` is flipped
  // on for in-app smoke-testing (REQ §11 — IndexedDB-backed persistence
  // is post-MVP). Split-mode tests opt in explicitly via overrides.
  const cpu = new Z80Cpu();
  const bus = makeBus64k(cpu, {
    ...DEFAULT_BUS_CONFIG,
    splitIo: false,
    ...overrides,
  });
  return { cpu, bus };
}

// Drives a single bus cycle by setting only the relevant pins; everything
// not passed defaults to deasserted (1). Shared across the per-cycle and
// last-touched describes so each test stays self-explanatory.
function setPins(
  cpu: Z80Cpu,
  pins: Partial<{
    nM1: 0 | 1;
    nMREQ: 0 | 1;
    nIORQ: 0 | 1;
    nRD: 0 | 1;
    nWR: 0 | 1;
    addr: number;
    data: number | undefined;
  }>,
): void {
  cpu.bus.nM1 = pins.nM1 ?? 1;
  cpu.bus.nMREQ = pins.nMREQ ?? 1;
  cpu.bus.nIORQ = pins.nIORQ ?? 1;
  cpu.bus.nRD = pins.nRD ?? 1;
  cpu.bus.nWR = pins.nWR ?? 1;
  if (pins.addr !== undefined) cpu.bus.addr = pins.addr;
  if ("data" in pins) cpu.bus.data = pins.data;
}

describe("makeBus64k", () => {
  it("fills mem and IO with the configured init bytes (default FF per REQ §6.6/§6.7)", () => {
    const { bus } = freshBus();
    expect(bus.mem.length).toBe(MEM_SIZE);
    expect(bus.ioRead.length).toBe(IO_SIZE);
    expect(bus.mem.every((b) => b === 0xff)).toBe(true);
    expect(bus.ioRead.every((b) => b === 0xff)).toBe(true);
  });

  it("honors override config for each space independently", () => {
    const { bus } = freshBus({
      memInit: 0x00,
      ioInit: 0xa5,
      intVectorInit: 0x42,
    });
    expect(bus.mem.every((b) => b === 0x00)).toBe(true);
    expect(bus.ioRead.every((b) => b === 0xa5)).toBe(true);
    expect(bus.intVector()).toBe(0x42);
  });

  it("masks init bytes to 8 bits at the boundary", () => {
    const { bus } = freshBus({
      memInit: 0x1ff,
      ioInit: 0x2aa,
      intVectorInit: 0x1ab,
    });
    expect(bus.mem[0]).toBe(0xff);
    expect(bus.ioRead[0]).toBe(0xaa);
    expect(bus.intVector()).toBe(0xab);
  });

  it("defaults the INT vector to FF (REQ §6.4)", () => {
    const { bus } = freshBus();
    expect(bus.intVector()).toBe(0xff);
  });

  it("places mem byte on cpu.bus.data during memory read", () => {
    const { cpu, bus } = freshBus({ memInit: 0 });
    bus.mem[0x1234] = 0x42;
    cpu.bus.nMREQ = 0;
    cpu.bus.nRD = 0;
    cpu.bus.nWR = 1;
    cpu.bus.nIORQ = 1;
    cpu.bus.addr = 0x1234;
    cpu.bus.data = undefined;
    bus.resolve();
    expect(cpu.bus.data).toBe(0x42);
  });

  it("latches cpu.bus.data into mem during memory write", () => {
    const { cpu, bus } = freshBus({ memInit: 0 });
    cpu.bus.nMREQ = 0;
    cpu.bus.nRD = 1;
    cpu.bus.nWR = 0;
    cpu.bus.nIORQ = 1;
    cpu.bus.addr = 0x8000;
    cpu.bus.data = 0xa5;
    bus.resolve();
    expect(bus.mem[0x8000]).toBe(0xa5);
  });

  it("services IO read/write against the io array", () => {
    const { cpu, bus } = freshBus({ ioInit: 0 });
    bus.ioRead[0xfe] = 0xbf;
    // IO read at 0xfe
    cpu.bus.nM1 = 1;
    cpu.bus.nIORQ = 0;
    cpu.bus.nMREQ = 1;
    cpu.bus.nRD = 0;
    cpu.bus.nWR = 1;
    cpu.bus.addr = 0x00fe;
    cpu.bus.data = undefined;
    bus.resolve();
    expect(cpu.bus.data).toBe(0xbf);
    // IO write at 0xfe
    cpu.bus.nRD = 1;
    cpu.bus.nWR = 0;
    cpu.bus.data = 0x07;
    bus.resolve();
    expect(bus.ioRead[0x00fe]).toBe(0x07);
  });

  it("places INT vector on cpu.bus.data when M1 + IORQ are both asserted", () => {
    const { cpu, bus } = freshBus();
    bus.setIntVector(0x42);
    cpu.bus.nM1 = 0;
    cpu.bus.nIORQ = 0;
    cpu.bus.nMREQ = 1;
    cpu.bus.nRD = 1;
    cpu.bus.nWR = 1;
    cpu.bus.addr = 0x0000;
    cpu.bus.data = undefined;
    bus.resolve();
    expect(cpu.bus.data).toBe(0x42);
  });

  it("does NOT inject INT vector during a plain IO cycle (M1 high)", () => {
    const { cpu, bus } = freshBus({ ioInit: 0 });
    bus.setIntVector(0x42);
    bus.ioRead[0x00] = 0x99;
    cpu.bus.nM1 = 1;
    cpu.bus.nIORQ = 0;
    cpu.bus.nMREQ = 1;
    cpu.bus.nRD = 0;
    cpu.bus.nWR = 1;
    cpu.bus.addr = 0x0000;
    cpu.bus.data = undefined;
    bus.resolve();
    expect(cpu.bus.data).toBe(0x99);
  });

  it("masks INT vector to 8 bits via setIntVector", () => {
    const { cpu, bus } = freshBus();
    bus.setIntVector(0x1ff);
    expect(bus.intVector()).toBe(0xff);
    cpu.bus.nM1 = 0;
    cpu.bus.nIORQ = 0;
    bus.resolve();
    expect(cpu.bus.data).toBe(0xff);
  });

  describe("broadcastIoLowByte", () => {
    it("writes value to all 256 high-byte aliases of the port", () => {
      const { bus } = freshBus();
      bus.broadcastIoLowByte(0x80, 0x5a);
      for (let hi = 0; hi < 256; hi++) {
        expect(bus.ioRead[(hi << 8) | 0x80]).toBe(0x5a);
      }
    });

    it("does not touch other ports", () => {
      const { bus } = freshBus();
      bus.ioRead.fill(0xee); // sentinel
      bus.broadcastIoLowByte(0x10, 0x11);
      // Aliases of 0x10 changed; aliases of every other port untouched.
      for (let hi = 0; hi < 256; hi++) {
        expect(bus.ioRead[(hi << 8) | 0x10]).toBe(0x11);
        expect(bus.ioRead[(hi << 8) | 0x11]).toBe(0xee);
      }
    });

    it("masks port and value to 8 bits at the boundary", () => {
      const { bus } = freshBus();
      bus.ioRead.fill(0); // zero so the mask check has a clean baseline
      // 0x1180 → port 0x80; 0x1ff → value 0xff.
      bus.broadcastIoLowByte(0x1180, 0x1ff);
      expect(bus.ioRead[0x0080]).toBe(0xff);
      expect(bus.ioRead[0xff80]).toBe(0xff);
      // Confirms port mask: nothing landed at port 0x11 aliases.
      expect(bus.ioRead[0x0011]).toBe(0);
      expect(bus.ioRead[0xff11]).toBe(0);
    });
  });

  it("reads the latest INT vector on each ack", () => {
    const { cpu, bus } = freshBus();
    bus.setIntVector(0x10);
    cpu.bus.nM1 = 0;
    cpu.bus.nIORQ = 0;
    cpu.bus.nMREQ = 1;
    cpu.bus.nRD = 1;
    cpu.bus.nWR = 1;
    bus.resolve();
    expect(cpu.bus.data).toBe(0x10);
    bus.setIntVector(0xee);
    cpu.bus.data = undefined;
    bus.resolve();
    expect(cpu.bus.data).toBe(0xee);
  });

  describe("last-touched tracking", () => {
    it("all accessors return null on a fresh bus", () => {
      const { bus } = freshBus();
      expect(bus.lastMemRead()).toBeNull();
      expect(bus.lastMemWrite()).toBeNull();
      expect(bus.lastIoRead()).toBeNull();
      expect(bus.lastIoWrite()).toBeNull();
    });

    it("captures mem reads with the byte placed on the bus", () => {
      const { cpu, bus } = freshBus({ memInit: 0 });
      bus.mem[0x1234] = 0x42;
      setPins(cpu, { nMREQ: 0, nRD: 0, addr: 0x1234 });
      bus.resolve();
      expect(bus.lastMemRead()).toEqual({ addr: 0x1234, value: 0x42 });
      // Write trackers untouched.
      expect(bus.lastMemWrite()).toBeNull();
    });

    it("captures mem writes with the byte latched into mem", () => {
      const { cpu, bus } = freshBus({ memInit: 0 });
      setPins(cpu, { nMREQ: 0, nWR: 0, addr: 0x8000, data: 0xa5 });
      bus.resolve();
      expect(bus.lastMemWrite()).toEqual({ addr: 0x8000, value: 0xa5 });
      expect(bus.lastMemRead()).toBeNull();
    });

    it("tracks mem reads and writes independently", () => {
      const { cpu, bus } = freshBus({ memInit: 0 });
      bus.mem[0x0010] = 0x33;
      setPins(cpu, { nMREQ: 0, nRD: 0, addr: 0x0010 });
      bus.resolve();
      setPins(cpu, { nMREQ: 0, nWR: 0, addr: 0x0020, data: 0x77 });
      bus.resolve();
      expect(bus.lastMemRead()).toEqual({ addr: 0x0010, value: 0x33 });
      expect(bus.lastMemWrite()).toEqual({ addr: 0x0020, value: 0x77 });
    });

    it("captures IO reads and writes; doesn't conflate with mem trackers", () => {
      const { cpu, bus } = freshBus({ ioInit: 0 });
      bus.ioRead[0x00fe] = 0xbf;
      setPins(cpu, { nIORQ: 0, nRD: 0, addr: 0x00fe });
      bus.resolve();
      setPins(cpu, { nIORQ: 0, nWR: 0, addr: 0x00fe, data: 0x07 });
      bus.resolve();
      expect(bus.lastIoRead()).toEqual({ addr: 0x00fe, value: 0xbf });
      expect(bus.lastIoWrite()).toEqual({ addr: 0x00fe, value: 0x07 });
      expect(bus.lastMemRead()).toBeNull();
      expect(bus.lastMemWrite()).toBeNull();
    });

    it("does NOT count INT acknowledge as an IO read", () => {
      const { cpu, bus } = freshBus();
      bus.setIntVector(0x42);
      // M1 + IORQ asserted — INT ack, byte placed from intVector, not io[].
      setPins(cpu, { nM1: 0, nIORQ: 0, addr: 0x0000 });
      bus.resolve();
      expect(cpu.bus.data).toBe(0x42);
      expect(bus.lastIoRead()).toBeNull();
      expect(bus.lastIoWrite()).toBeNull();
    });

    it("most-recent semantics: each new cycle overwrites the prior record", () => {
      const { cpu, bus } = freshBus({ memInit: 0 });
      bus.mem[0x0001] = 0x11;
      bus.mem[0x0002] = 0x22;
      setPins(cpu, { nMREQ: 0, nRD: 0, addr: 0x0001 });
      bus.resolve();
      expect(bus.lastMemRead()).toEqual({ addr: 0x0001, value: 0x11 });
      setPins(cpu, { nMREQ: 0, nRD: 0, addr: 0x0002 });
      bus.resolve();
      expect(bus.lastMemRead()).toEqual({ addr: 0x0002, value: 0x22 });
    });

    it("returns a fresh record each call (no shared aliasing)", () => {
      const { cpu, bus } = freshBus({ memInit: 0 });
      bus.mem[0x1000] = 0xaa;
      setPins(cpu, { nMREQ: 0, nRD: 0, addr: 0x1000 });
      bus.resolve();
      const a = bus.lastMemRead();
      const b = bus.lastMemRead();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("split IO (REQ §11)", () => {
    it("joined mode: ioWrite null, single plane services both directions", () => {
      const { cpu, bus } = freshBus({ ioInit: 0, splitIo: false });
      expect(bus.splitIo).toBe(false);
      expect(bus.ioWrite).toBeNull();
      // OUT lands in the joined plane (which is ioRead), so a follow-up
      // IN at the same port reads it back.
      setPins(cpu, { nIORQ: 0, nWR: 0, addr: 0x00fe, data: 0xa5 });
      bus.resolve();
      expect(bus.ioRead[0x00fe]).toBe(0xa5);
      setPins(cpu, { nIORQ: 0, nRD: 0, addr: 0x00fe });
      bus.resolve();
      expect(cpu.bus.data).toBe(0xa5);
    });

    it("split: both planes fill to ioInit on construction", () => {
      const { bus } = freshBus({ ioInit: 0xa5, splitIo: true });
      expect(bus.splitIo).toBe(true);
      expect(bus.ioWrite).not.toBeNull();
      expect(bus.ioRead.every((b) => b === 0xa5)).toBe(true);
      expect(bus.ioWrite?.every((b) => b === 0xa5)).toBe(true);
    });

    it("split: IN reads RD plane, OUT lands in WR plane, RD untouched by OUT", () => {
      const { cpu, bus } = freshBus({ ioInit: 0, splitIo: true });
      // Pre-load RD plane the way a user would.
      bus.ioRead[0x00fe] = 0xbf;
      // CPU OUT should NOT touch RD; it should land in WR.
      setPins(cpu, { nIORQ: 0, nWR: 0, addr: 0x00fe, data: 0x07 });
      bus.resolve();
      expect(bus.ioRead[0x00fe]).toBe(0xbf);
      expect(bus.ioWrite?.[0x00fe]).toBe(0x07);
      // CPU IN should still read the RD-plane byte, not the WR-plane one.
      setPins(cpu, { nIORQ: 0, nRD: 0, addr: 0x00fe });
      bus.resolve();
      expect(cpu.bus.data).toBe(0xbf);
    });

    it("split: lastIoRead samples from RD, lastIoWrite from WR", () => {
      const { cpu, bus } = freshBus({ ioInit: 0, splitIo: true });
      bus.ioRead[0x00fe] = 0xbf;
      setPins(cpu, { nIORQ: 0, nRD: 0, addr: 0x00fe });
      bus.resolve();
      setPins(cpu, { nIORQ: 0, nWR: 0, addr: 0x00fe, data: 0x07 });
      bus.resolve();
      expect(bus.lastIoRead()).toEqual({ addr: 0x00fe, value: 0xbf });
      expect(bus.lastIoWrite()).toEqual({ addr: 0x00fe, value: 0x07 });
    });

    it("split: broadcastIoLowByte still targets RD (user only edits RD plane)", () => {
      const { bus } = freshBus({ ioInit: 0, splitIo: true });
      bus.broadcastIoLowByte(0x80, 0x5a);
      for (let hi = 0; hi < 256; hi++) {
        expect(bus.ioRead[(hi << 8) | 0x80]).toBe(0x5a);
        expect(bus.ioWrite?.[(hi << 8) | 0x80]).toBe(0); // untouched
      }
    });
  });

  // ── Input pins (M8b, REQ §6.4) ───────────────────────────────────

  describe("input pins (M8b)", () => {
    it("defaults all five level pins to deasserted (1)", () => {
      const { bus } = freshBus();
      for (const name of [
        "nINT",
        "nNMI",
        "nRESET",
        "nBUSRQ",
        "nWAIT",
      ] as const) {
        expect(bus.getInputPin(name)).toBe(1);
      }
    });

    it("setInputPin masks the value to 0|1 at the boundary", () => {
      const { bus } = freshBus();
      // Any odd value collapses to 1, any even non-zero to 0 — the bus
      // doesn't trust upstream masking (validation-boundary rule).
      bus.setInputPin("nINT", 5 as 0 | 1);
      expect(bus.getInputPin("nINT")).toBe(1);
      bus.setInputPin("nINT", 4 as 0 | 1);
      expect(bus.getInputPin("nINT")).toBe(0);
    });

    it("resolve() applies level pins to cpu.bus", () => {
      const { cpu, bus } = freshBus();
      bus.setInputPin("nINT", 0);
      bus.setInputPin("nRESET", 0);
      bus.setInputPin("nBUSRQ", 0);
      bus.setInputPin("nWAIT", 0);
      // resolve runs the preEdge hook — drives the pins onto cpu.bus.
      bus.resolve();
      expect(cpu.bus.nINT).toBe(0);
      expect(cpu.bus.nRESET).toBe(0);
      expect(cpu.bus.nBUSRQ).toBe(0);
      expect(cpu.bus.nWAIT).toBe(0);
    });

    it("nNMI asserted fires cpu.nmi() via resolve (sets nmiFf)", () => {
      const { cpu, bus } = freshBus();
      expect(cpu.ctl.nmiFf).toBe(false);
      bus.setInputPin("nNMI", 0);
      bus.resolve();
      expect(cpu.ctl.nmiFf).toBe(true);
    });

    it("nNMI deasserted does NOT call cpu.nmi()", () => {
      const { cpu, bus } = freshBus();
      bus.resolve(); // nNMI default 1, should not set nmiFf
      expect(cpu.ctl.nmiFf).toBe(false);
    });
  });
});
