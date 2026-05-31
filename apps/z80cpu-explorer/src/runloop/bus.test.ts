import { Z80Cpu } from "@dcorp80/z80cpu";
import { describe, expect, it } from "vitest";
import { type BusConfig, DEFAULT_BUS_CONFIG } from "../config/defaults.ts";
import { IO_SIZE, MEM_SIZE, makeBus64k } from "./bus.ts";

function freshBus(overrides: Partial<BusConfig> = {}) {
  const cpu = new Z80Cpu();
  const bus = makeBus64k(cpu, { ...DEFAULT_BUS_CONFIG, ...overrides });
  return { cpu, bus };
}

describe("makeBus64k", () => {
  it("fills mem and IO with the configured init bytes (default FF per REQ §6.6/§6.7)", () => {
    const { bus } = freshBus();
    expect(bus.mem.length).toBe(MEM_SIZE);
    expect(bus.io.length).toBe(IO_SIZE);
    expect(bus.mem.every((b) => b === 0xff)).toBe(true);
    expect(bus.io.every((b) => b === 0xff)).toBe(true);
  });

  it("honors override config for each space independently", () => {
    const { bus } = freshBus({
      memInit: 0x00,
      ioInit: 0xa5,
      intVectorInit: 0x42,
    });
    expect(bus.mem.every((b) => b === 0x00)).toBe(true);
    expect(bus.io.every((b) => b === 0xa5)).toBe(true);
    expect(bus.intVector()).toBe(0x42);
  });

  it("masks init bytes to 8 bits at the boundary", () => {
    const { bus } = freshBus({
      memInit: 0x1ff,
      ioInit: 0x2aa,
      intVectorInit: 0x1ab,
    });
    expect(bus.mem[0]).toBe(0xff);
    expect(bus.io[0]).toBe(0xaa);
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
    bus.io[0xfe] = 0xbf;
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
    expect(bus.io[0x00fe]).toBe(0x07);
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
    bus.io[0x00] = 0x99;
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
});
