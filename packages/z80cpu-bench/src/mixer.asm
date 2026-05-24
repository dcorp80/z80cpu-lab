; SPDX-License-Identifier: MIT
; Copyright 2026 dcorp80

;================================================================
; mixer.asm — Z80 mixer benchmark for @dcorp80/z80cpu
;
; Compile (sjasmplus):
;   sjasmplus mixer.asm --raw=mixer.bin
;
; Memory map:
;   $0000-$003F  vectors (JP main + RST handlers)
;   $0040+       main code, sweep subs, mixer body
;   $8000-$80FF  scratch buffer A
;   $8100-$81FF  scratch buffer B
;   $9000-$90FF  data scratch (16-bit loads/stores)
;   $A000-$A0FF  IX area (DDCB targets)
;   $B000-$B0FF  IY area (FDCB targets)
;   $C000        iteration counter (1 byte; harness pre-writes)
;   $CFFE        end sentinel — program writes SENT_VAL here at exit
;   $FFF0        stack top (peak depth ~6 levels = 12 bytes)
;
; Coverage strategy:
;   - sweep_all runs ONCE during init: every distinct encoding executed
;     at least once (HALT and RST 0 excluded, see notes below)
;   - chained mixer body runs N times: representative workload for bulk HC
;
; Excluded encodings (by design):
;   - $76 HALT (would suspend the CPU — not desired in a benchmark)
;   - $C7 RST 0 (target $0000 holds JP main → would re-enter init
;                and corrupt program flow)
;
; Coverage TODO (still open, mechanical to add):
;   - undefined ED holes (ED 00-3F, ED 80-9F, ED AC-AF, ED BC-FF, ED 77, ED 7F):
;     real Z80 treats these as 8-T NOPs — large block of trivial encodings,
;     skipped here for file-size reasons. Add as DEFB if encoding-coverage
;     of NOP-equivalents matters.
;================================================================

ITER_COUNT      EQU 100
COUNTER_ADDR    EQU $C000
SENTINEL_ADDR   EQU $CFFE
SENT_VAL        EQU $DE
STACK_TOP       EQU $FFF0
BUF_A           EQU $8000
BUF_B           EQU $8100
DATA            EQU $9000
IX_BASE         EQU $A000
IY_BASE         EQU $B000

;----------------------------------------------------------------
; Vectors
;----------------------------------------------------------------
                ORG $0000
                JP   main

                ORG $0008
                RET                 ; RST 8 handler
                ORG $0010
                RET
                ORG $0018
                RET
                ORG $0020
                RET
                ORG $0028
                RET
                ORG $0030
                RET
                ORG $0038
                RET                 ; (also IM 1 INT vector — unused)

;----------------------------------------------------------------
; main
;----------------------------------------------------------------
                ORG $0040
main:
                LD   SP, STACK_TOP

                ; Pre-fill BUF_A and BUF_B with deterministic data so block
                ; ops have non-trivial work and (HL) reads return varied bytes.
                LD   HL, BUF_A
                LD   C, 0
fill_a:
                LD   A, L
                XOR  H
                LD   (HL), A
                INC  HL
                DEC  C
                JR   NZ, fill_a

                LD   HL, BUF_B
                LD   C, 0
fill_b:
                LD   A, L
                CPL
                LD   (HL), A
                INC  HL
                DEC  C
                JR   NZ, fill_b

                ; Prime registers (referenced by sweeps that assume nonzero
                ; A/B/.../H/L for safe HL convergence in LD r,r' carousel).
                LD   A, $5A
                LD   B, $C3
                LD   C, $18
                LD   D, $A5
                LD   E, $42
                LD   H, $80
                LD   L, $00
                LD   IX, IX_BASE
                LD   IY, IY_BASE

                EX   AF, AF'
                LD   A, $A5
                EX   AF, AF'

                EXX
                LD   B, $11
                LD   C, $22
                LD   D, $33
                LD   E, $44
                LD   H, $55
                LD   L, $66
                EXX

                LD   A, $5A
                LD   I, A
                LD   R, A
                IM   1

                ; ── full-encoding coverage sweeps (run once) ──
                CALL sweep_all

                ; Restore a known-good baseline before entering the loop body
                ; (sweeps freely mutate registers, IX/IY, IFF1/IFF2, IM, etc.).
                LD   SP, STACK_TOP
                LD   A, $5A
                LD   B, $C3
                LD   C, $18
                LD   D, $A5
                LD   E, $42
                LD   H, $80
                LD   L, $00
                LD   IX, IX_BASE
                LD   IY, IY_BASE
                IM   1

                JP   loop_top

;================================================================
; sweep_all — call every encoding-coverage sweep exactly once
;================================================================
sweep_all:
                CALL sweep_unprefixed_misc
                CALL sweep_inc_dec_r
                CALL sweep_ld_rr_carousel
                CALL sweep_alu_r
                CALL sweep_cb_rot_regs
                CALL sweep_cb_rot_hl
                CALL sweep_cb_bit
                CALL sweep_cb_res_regs
                CALL sweep_cb_res_hl
                CALL sweep_cb_set_regs
                CALL sweep_cb_set_hl
                CALL sweep_ed_basic
                CALL sweep_ed_aliases
                CALL sweep_ed_blocks
                CALL sweep_ed_io_blocks
                CALL sweep_dd_doc
                CALL sweep_dd_idxhl
                CALL sweep_fd_doc
                CALL sweep_fd_iyhl
                CALL sweep_ddcb
                CALL sweep_fdcb
                RET

;----------------------------------------------------------------
; sweep_unprefixed_misc
;
; Unprefixed opcodes that aren't in the LD r,r' / ALU r / INC/DEC carousels.
; Many overlap with the chained body but are listed here to make encoding
; coverage explicit and self-checkable.
;----------------------------------------------------------------
sweep_unprefixed_misc:
                NOP                     ; $00
                LD   BC, $1234          ; $01 (LD BC,nn)
                LD   (BC), A            ; $02
                LD   A, (BC)            ; $0A
                INC  BC                 ; $03
                DEC  BC                 ; $0B
                LD   B, $11             ; $06 (LD B,n)
                LD   C, $22             ; $0E
                EX   AF, AF'            ; $08
                EX   AF, AF'            ; (back)
                ADD  HL, BC             ; $09
                RLCA                    ; $07
                RRCA                    ; $0F
                LD   B, $05
djnz_local:
                DJNZ djnz_local         ; $10
                LD   DE, $5678          ; $11
                LD   (DE), A            ; $12
                LD   A, (DE)            ; $1A
                INC  DE                 ; $13
                DEC  DE                 ; $1B
                LD   D, $33             ; $16
                LD   E, $44             ; $1E
                JR   jr_skip            ; $18
                NOP                     ; (skipped)
jr_skip:
                ADD  HL, DE             ; $19
                RLA                     ; $17
                RRA                     ; $1F
                JR   NZ, jrnz_skip      ; $20 (taken or not — instr is decoded)
                NOP
jrnz_skip:
                JR   Z,  jrz_skip       ; $28
                NOP
jrz_skip:
                JR   NC, jrnc_skip      ; $30
                NOP
jrnc_skip:
                JR   C,  jrc_skip       ; $38
                NOP
jrc_skip:
                LD   HL, $9000          ; $21
                LD   ($90E0), HL        ; $22
                LD   HL, ($90E0)        ; $2A
                INC  HL                 ; $23
                DEC  HL                 ; $2B
                LD   H, $80             ; $26
                LD   L, $00             ; $2E
                ADD  HL, HL             ; $29
                DAA                     ; $27
                CPL                     ; $2F
                ; LD SP,nn ($31) — destructive; save/restore real SP
                LD   ($90D0), SP
                LD   SP, $1234          ; $31 (encoding under test)
                LD   SP, ($90D0)
                LD   ($90E2), A         ; $32
                LD   A, ($90E2)         ; $3A
                INC  SP                 ; $33
                DEC  SP                 ; $3B
                LD   HL, BUF_A
                LD   (HL), $42          ; $36 (LD (HL),n)
                LD   A, $5A             ; $3E
                ADD  HL, SP             ; $39
                SCF                     ; $37
                CCF                     ; $3F

                ; ALU n (8 ops: $C6, $CE, $D6, $DE, $E6, $EE, $F6, $FE)
                ADD  A, $11             ; $C6
                ADC  A, $22             ; $CE
                SUB  $33                ; $D6
                SBC  A, $44             ; $DE
                AND  $F0                ; $E6
                XOR  $55                ; $EE
                OR   $0C                ; $F6
                CP   $80                ; $FE

                ; PUSH/POP all four pairs ($C5/D5/E5/F5, $C1/D1/E1/F1)
                PUSH AF                 ; $F5
                PUSH BC                 ; $C5
                PUSH DE                 ; $D5
                PUSH HL                 ; $E5
                POP  HL                 ; $E1
                POP  DE                 ; $D1
                POP  BC                 ; $C1
                POP  AF                 ; $F1

                ; conditional JP — all 8 conditions ($C2/CA/D2/DA/E2/EA/F2/FA)
                JP   NZ, _jpnz
                NOP
_jpnz:          JP   Z, _jpz
                NOP
_jpz:           JP   NC, _jpnc
                NOP
_jpnc:          JP   C, _jpc
                NOP
_jpc:           JP   PO, _jppo
                NOP
_jppo:          JP   PE, _jppe
                NOP
_jppe:          JP   P, _jpp
                NOP
_jpp:           JP   M, _jpm
                NOP
_jpm:
                ; unconditional JP nn
                JP   _aftercjp          ; $C3
_aftercjp:

                ; conditional CALL — all 8 + uncond CALL nn ($CD)
                CALL _csub              ; $CD
                CALL Z,  _csub          ; $CC
                CALL NZ, _csub          ; $C4
                CALL C,  _csub          ; $DC
                CALL NC, _csub          ; $D4
                CALL PO, _csub          ; $E4
                CALL PE, _csub          ; $EC
                CALL P,  _csub          ; $F4
                CALL M,  _csub          ; $FC

                ; RST $08-$38 (RST $00 excluded — collides with reset vector)
                RST  $08                ; $CF
                RST  $10                ; $D7
                RST  $18                ; $DF
                RST  $20                ; $E7
                RST  $28                ; $EF
                RST  $30                ; $F7
                RST  $38                ; $FF

                ; IN A,(n) / OUT (n),A
                LD   A, $42
                OUT  ($80), A           ; $D3
                IN   A, ($80)           ; $DB

                ; exchanges and stack/SP ops
                ; EX (SP),HL needs a scratch entry on top of the stack —
                ; otherwise it swaps with our own return address.
                LD   HL, $1234
                PUSH HL
                LD   HL, $5678
                EX   (SP), HL           ; $E3 — swap HL with our scratch
                POP  HL

                EX   DE, HL             ; $EB
                EX   DE, HL
                EXX                     ; $D9
                EXX

                ; LD SP,HL is destructive; save/restore real SP via memory
                ; round-trip ($90D0..$90D1).
                LD   ($90D0), SP
                LD   HL, $1234
                LD   SP, HL             ; $F9
                LD   SP, ($90D0)

                ; JP (HL)
                LD   HL, _afterjphl
                JP   (HL)               ; $E9
                NOP
_afterjphl:
                DI                      ; $F3
                EI                      ; $FB
                RET                     ; $C9 (returns from sweep_unprefixed_misc)

; Subroutine called by conditional CALLs above. Each RET cc is decoded
; whether it returns or not, so all 8 RET cc encodings get exercised across
; the multiple calls.
_csub:
                NOP
                RET  Z                  ; $C8
                RET  NZ                 ; $C0
                RET  C                  ; $D8
                RET  NC                 ; $D0
                RET  PO                 ; $E0
                RET  PE                 ; $E8
                RET  P                  ; $F0
                RET  M                  ; $F8
                RET                     ; $C9 (always returns)

;----------------------------------------------------------------
; sweep_inc_dec_r
;   $04/05, $0C/0D, $14/15, $1C/1D, $24/25, $2C/2D, $34/35, $3C/3D
;----------------------------------------------------------------
sweep_inc_dec_r:
                INC  B                  ; $04
                DEC  B                  ; $05
                INC  C                  ; $0C
                DEC  C                  ; $0D
                INC  D                  ; $14
                DEC  D                  ; $15
                INC  E                  ; $1C
                DEC  E                  ; $1D
                INC  H                  ; $24
                DEC  H                  ; $25
                INC  L                  ; $2C
                DEC  L                  ; $2D
                LD   HL, BUF_A
                INC  (HL)               ; $34
                DEC  (HL)               ; $35
                INC  A                  ; $3C
                DEC  A                  ; $3D
                RET

;----------------------------------------------------------------
; sweep_ld_rr_carousel — all 63 LD r,r' encodings ($40-$7F minus $76)
;
; Safety: with A=$5A pre-set, all main regs converge to $5A after their
; LD r,r row, so HL ends as $5A5A before the LD (HL),r row. Writes go to
; mem[$5A5A] (uninitialised RAM, well clear of program code).
;----------------------------------------------------------------
sweep_ld_rr_carousel:
                LD   A, $5A
                LD   B, $5A
                LD   C, $5A
                LD   D, $5A
                LD   E, $5A
                LD   H, $80
                LD   L, $00
                ; LD B, r ($40-$47)
                DEFB $40, $41, $42, $43, $44, $45, $46, $47
                ; LD C, r ($48-$4F)
                DEFB $48, $49, $4A, $4B, $4C, $4D, $4E, $4F
                ; LD D, r ($50-$57)
                DEFB $50, $51, $52, $53, $54, $55, $56, $57
                ; LD E, r ($58-$5F)
                DEFB $58, $59, $5A, $5B, $5C, $5D, $5E, $5F
                ; LD H, r ($60-$67) — H rotates through other reg values
                DEFB $60, $61, $62, $63, $64, $65, $66, $67
                ; LD L, r ($68-$6F)
                DEFB $68, $69, $6A, $6B, $6C, $6D, $6E, $6F
                ; LD (HL), r ($70-$77, skipping $76 = HALT)
                DEFB $70, $71, $72, $73, $74, $75,      $77
                ; LD A, r ($78-$7F)
                DEFB $78, $79, $7A, $7B, $7C, $7D, $7E, $7F
                RET

;----------------------------------------------------------------
; sweep_alu_r — all 64 ALU A,r encodings ($80-$BF, includes (HL) variants)
; Safe to include (HL) since ALU A,r doesn't modify H or L.
;----------------------------------------------------------------
sweep_alu_r:
                LD   A, $5A
                LD   HL, BUF_A
                ; ADD A,r  ($80-$87)
                DEFB $80, $81, $82, $83, $84, $85, $86, $87
                ; ADC A,r  ($88-$8F)
                DEFB $88, $89, $8A, $8B, $8C, $8D, $8E, $8F
                ; SUB r    ($90-$97)
                DEFB $90, $91, $92, $93, $94, $95, $96, $97
                ; SBC A,r  ($98-$9F)
                DEFB $98, $99, $9A, $9B, $9C, $9D, $9E, $9F
                ; AND r    ($A0-$A7)
                DEFB $A0, $A1, $A2, $A3, $A4, $A5, $A6, $A7
                ; XOR r    ($A8-$AF)
                DEFB $A8, $A9, $AA, $AB, $AC, $AD, $AE, $AF
                ; OR r     ($B0-$B7)
                DEFB $B0, $B1, $B2, $B3, $B4, $B5, $B6, $B7
                ; CP r     ($B8-$BF)
                DEFB $B8, $B9, $BA, $BB, $BC, $BD, $BE, $BF
                RET

;----------------------------------------------------------------
; sweep_cb_rot_regs — CB rot/shift on r != (HL) (56 encodings)
;
; Excluded: $X6 in $00-$3F (the (HL) variants). Those are run separately
; with HL re-pinned to BUF_A, since rot/shift on H or L can drive HL into
; program code before we'd hit the (HL) variant in a contiguous sweep.
;----------------------------------------------------------------
sweep_cb_rot_regs:
                ; RLC r ($CB $00-$05, $07)
                DEFB $CB,$00, $CB,$01, $CB,$02, $CB,$03, $CB,$04, $CB,$05,             $CB,$07
                ; RRC
                DEFB $CB,$08, $CB,$09, $CB,$0A, $CB,$0B, $CB,$0C, $CB,$0D,             $CB,$0F
                ; RL
                DEFB $CB,$10, $CB,$11, $CB,$12, $CB,$13, $CB,$14, $CB,$15,             $CB,$17
                ; RR
                DEFB $CB,$18, $CB,$19, $CB,$1A, $CB,$1B, $CB,$1C, $CB,$1D,             $CB,$1F
                ; SLA
                DEFB $CB,$20, $CB,$21, $CB,$22, $CB,$23, $CB,$24, $CB,$25,             $CB,$27
                ; SRA
                DEFB $CB,$28, $CB,$29, $CB,$2A, $CB,$2B, $CB,$2C, $CB,$2D,             $CB,$2F
                ; SLL (undocumented — emit raw bytes in case sjasmplus dialect rejects mnemonic)
                DEFB $CB,$30, $CB,$31, $CB,$32, $CB,$33, $CB,$34, $CB,$35,             $CB,$37
                ; SRL
                DEFB $CB,$38, $CB,$39, $CB,$3A, $CB,$3B, $CB,$3C, $CB,$3D,             $CB,$3F
                RET

sweep_cb_rot_hl:
                LD   HL, BUF_A
                DEFB $CB,$06            ; RLC (HL)
                DEFB $CB,$0E            ; RRC (HL)
                DEFB $CB,$16            ; RL  (HL)
                DEFB $CB,$1E            ; RR  (HL)
                DEFB $CB,$26            ; SLA (HL)
                DEFB $CB,$2E            ; SRA (HL)
                DEFB $CB,$36            ; SLL (HL) — undocumented
                DEFB $CB,$3E            ; SRL (HL)
                RET

;----------------------------------------------------------------
; sweep_cb_bit — all 64 BIT n,r encodings ($CB $40-$7F)
;
; BIT does not modify the operand register, so the (HL) variants are safe
; to include in a contiguous sweep with HL pinned at entry.
;----------------------------------------------------------------
sweep_cb_bit:
                LD   HL, BUF_A
                DEFB $CB,$40, $CB,$41, $CB,$42, $CB,$43, $CB,$44, $CB,$45, $CB,$46, $CB,$47
                DEFB $CB,$48, $CB,$49, $CB,$4A, $CB,$4B, $CB,$4C, $CB,$4D, $CB,$4E, $CB,$4F
                DEFB $CB,$50, $CB,$51, $CB,$52, $CB,$53, $CB,$54, $CB,$55, $CB,$56, $CB,$57
                DEFB $CB,$58, $CB,$59, $CB,$5A, $CB,$5B, $CB,$5C, $CB,$5D, $CB,$5E, $CB,$5F
                DEFB $CB,$60, $CB,$61, $CB,$62, $CB,$63, $CB,$64, $CB,$65, $CB,$66, $CB,$67
                DEFB $CB,$68, $CB,$69, $CB,$6A, $CB,$6B, $CB,$6C, $CB,$6D, $CB,$6E, $CB,$6F
                DEFB $CB,$70, $CB,$71, $CB,$72, $CB,$73, $CB,$74, $CB,$75, $CB,$76, $CB,$77
                DEFB $CB,$78, $CB,$79, $CB,$7A, $CB,$7B, $CB,$7C, $CB,$7D, $CB,$7E, $CB,$7F
                RET

;----------------------------------------------------------------
; sweep_cb_res_regs / sweep_cb_res_hl — RES n,r split (HL safety)
;----------------------------------------------------------------
sweep_cb_res_regs:
                ; $CB $80-$BF skipping every $X6
                DEFB $CB,$80, $CB,$81, $CB,$82, $CB,$83, $CB,$84, $CB,$85,             $CB,$87
                DEFB $CB,$88, $CB,$89, $CB,$8A, $CB,$8B, $CB,$8C, $CB,$8D,             $CB,$8F
                DEFB $CB,$90, $CB,$91, $CB,$92, $CB,$93, $CB,$94, $CB,$95,             $CB,$97
                DEFB $CB,$98, $CB,$99, $CB,$9A, $CB,$9B, $CB,$9C, $CB,$9D,             $CB,$9F
                DEFB $CB,$A0, $CB,$A1, $CB,$A2, $CB,$A3, $CB,$A4, $CB,$A5,             $CB,$A7
                DEFB $CB,$A8, $CB,$A9, $CB,$AA, $CB,$AB, $CB,$AC, $CB,$AD,             $CB,$AF
                DEFB $CB,$B0, $CB,$B1, $CB,$B2, $CB,$B3, $CB,$B4, $CB,$B5,             $CB,$B7
                DEFB $CB,$B8, $CB,$B9, $CB,$BA, $CB,$BB, $CB,$BC, $CB,$BD,             $CB,$BF
                RET

sweep_cb_res_hl:
                LD   HL, BUF_A
                DEFB $CB,$86            ; RES 0,(HL)
                DEFB $CB,$8E            ; RES 1
                DEFB $CB,$96            ; RES 2
                DEFB $CB,$9E            ; RES 3
                DEFB $CB,$A6            ; RES 4
                DEFB $CB,$AE            ; RES 5
                DEFB $CB,$B6            ; RES 6
                DEFB $CB,$BE            ; RES 7
                RET

;----------------------------------------------------------------
; sweep_cb_set_regs / sweep_cb_set_hl — SET n,r split (HL safety)
;----------------------------------------------------------------
sweep_cb_set_regs:
                ; $CB $C0-$FF skipping every $X6
                DEFB $CB,$C0, $CB,$C1, $CB,$C2, $CB,$C3, $CB,$C4, $CB,$C5,             $CB,$C7
                DEFB $CB,$C8, $CB,$C9, $CB,$CA, $CB,$CB, $CB,$CC, $CB,$CD,             $CB,$CF
                DEFB $CB,$D0, $CB,$D1, $CB,$D2, $CB,$D3, $CB,$D4, $CB,$D5,             $CB,$D7
                DEFB $CB,$D8, $CB,$D9, $CB,$DA, $CB,$DB, $CB,$DC, $CB,$DD,             $CB,$DF
                DEFB $CB,$E0, $CB,$E1, $CB,$E2, $CB,$E3, $CB,$E4, $CB,$E5,             $CB,$E7
                DEFB $CB,$E8, $CB,$E9, $CB,$EA, $CB,$EB, $CB,$EC, $CB,$ED,             $CB,$EF
                DEFB $CB,$F0, $CB,$F1, $CB,$F2, $CB,$F3, $CB,$F4, $CB,$F5,             $CB,$F7
                DEFB $CB,$F8, $CB,$F9, $CB,$FA, $CB,$FB, $CB,$FC, $CB,$FD,             $CB,$FF
                RET

sweep_cb_set_hl:
                LD   HL, BUF_A
                DEFB $CB,$C6            ; SET 0,(HL)
                DEFB $CB,$CE            ; SET 1
                DEFB $CB,$D6            ; SET 2
                DEFB $CB,$DE            ; SET 3
                DEFB $CB,$E6            ; SET 4
                DEFB $CB,$EE            ; SET 5
                DEFB $CB,$F6            ; SET 6
                DEFB $CB,$FE            ; SET 7
                RET

;----------------------------------------------------------------
; sweep_ed_basic — defined ED ops other than block / IO-block / aliases
;
; Covers: IN/OUT (C) for all r, ADC/SBC HL,rr × 4 pairs, LD (nn),rr / LD rr,(nn),
; canonical NEG, RETN, RETI, IM 0/1/2 (canonical encodings), LD I/A,A,
; LD R/A,A, RLD, RRD, IN F,(C) and OUT (C),0 (undocumented).
;----------------------------------------------------------------
sweep_ed_basic:
                ; --- 16-bit IO ($ED $40-$79 even/odd pairs) ---
                LD   BC, $9091
                IN   B, (C)             ; ED 40
                OUT  (C), B             ; ED 41
                IN   C, (C)             ; ED 48
                OUT  (C), C             ; ED 49
                IN   D, (C)             ; ED 50
                OUT  (C), D             ; ED 51
                IN   E, (C)             ; ED 58
                OUT  (C), E             ; ED 59
                IN   H, (C)             ; ED 60
                OUT  (C), H             ; ED 61
                IN   L, (C)             ; ED 68
                OUT  (C), L             ; ED 69
                DEFB $ED, $70           ; IN (C) / IN F,(C) — undocumented
                DEFB $ED, $71           ; OUT (C),0          — undocumented
                IN   A, (C)             ; ED 78
                OUT  (C), A             ; ED 79

                ; --- 16-bit ALU (SBC HL,rr at ED x2; ADC HL,rr at ED xA) ---
                LD   HL, $9000
                LD   BC, $1234
                LD   DE, $5678
                DEFB $ED, $42           ; SBC HL,BC
                DEFB $ED, $4A           ; ADC HL,BC
                DEFB $ED, $52           ; SBC HL,DE
                DEFB $ED, $5A           ; ADC HL,DE
                DEFB $ED, $62           ; SBC HL,HL
                DEFB $ED, $6A           ; ADC HL,HL
                DEFB $ED, $72           ; SBC HL,SP
                DEFB $ED, $7A           ; ADC HL,SP

                ; --- 16-bit memory loads/stores (ED forms) ---
                LD   HL, $9000
                LD   BC, $1357
                DEFB $ED, $43           ; LD (nn),BC
                DEFW $90A0
                DEFB $ED, $4B           ; LD BC,(nn)
                DEFW $90A0
                LD   DE, $2468
                DEFB $ED, $53           ; LD (nn),DE
                DEFW $90A4
                DEFB $ED, $5B           ; LD DE,(nn)
                DEFW $90A4
                DEFB $ED, $63           ; LD (nn),HL — alt encoding (same effect as $22)
                DEFW $90A8
                DEFB $ED, $6B           ; LD HL,(nn) — alt encoding
                DEFW $90A8
                DEFB $ED, $73           ; LD (nn),SP — saves SP to mem
                DEFW $90AC
                DEFB $ED, $7B           ; LD SP,(nn) — restores SP from mem
                DEFW $90AC              ; (round-trip preserves SP — no further reset needed)

                ; --- I and R, IM canonical, NEG, RETN/RETI canonical, RLD/RRD ---
                LD   A, $5A
                DEFB $ED, $47           ; LD I,A
                DEFB $ED, $57           ; LD A,I
                LD   A, $A5
                DEFB $ED, $4F           ; LD R,A
                DEFB $ED, $5F           ; LD A,R
                DEFB $ED, $46           ; IM 0
                DEFB $ED, $56           ; IM 1
                DEFB $ED, $5E           ; IM 2
                DEFB $ED, $44           ; NEG (canonical)
                ; canonical RETN ($ED $45) and RETI ($ED $4D) are exercised via
                ; sub-stubs called from sweep_ed_aliases (see below).
                LD   HL, BUF_A
                DEFB $ED, $6F           ; RLD
                DEFB $ED, $67           ; RRD
                IM   1
                RET

;----------------------------------------------------------------
; sweep_ed_aliases — duplicate/alias encodings (NEG, RETN, RETI, IM 0/1/2)
;
; Each alias is functionally identical to a canonical opcode but has a
; distinct encoding byte. Cover all of them for full encoding coverage.
;----------------------------------------------------------------
sweep_ed_aliases:
                ; NEG aliases: ED 4C, 54, 5C, 64, 6C, 74, 7C
                DEFB $ED, $4C
                DEFB $ED, $54
                DEFB $ED, $5C
                DEFB $ED, $64
                DEFB $ED, $6C
                DEFB $ED, $74
                DEFB $ED, $7C

                ; IM aliases:
                ;   IM 0 (undoc encodings): ED 4E, 66, 6E
                ;   IM 1 alias:             ED 76
                ;   IM 2 alias:             ED 7E
                DEFB $ED, $4E
                DEFB $ED, $66
                DEFB $ED, $6E
                DEFB $ED, $76
                DEFB $ED, $7E
                IM   1                  ; restore a known IM after the sweep

                ; RETN canonical + 3 aliases — each call enters a 2-byte stub
                ; whose only "instruction" is the RETN encoding being exercised.
                CALL _retn_45
                CALL _retn_55
                CALL _retn_65
                CALL _retn_75

                ; RETI canonical + 3 aliases
                CALL _reti_4d
                CALL _reti_5d
                CALL _reti_6d
                CALL _reti_7d
                RET

_retn_45:       DEFB $ED, $45           ; RETN canonical
_retn_55:       DEFB $ED, $55
_retn_65:       DEFB $ED, $65
_retn_75:       DEFB $ED, $75
_reti_4d:       DEFB $ED, $4D           ; RETI canonical
_reti_5d:       DEFB $ED, $5D
_reti_6d:       DEFB $ED, $6D
_reti_7d:       DEFB $ED, $7D

;----------------------------------------------------------------
; sweep_ed_blocks — LDI, LDD, LDIR, LDDR, CPI, CPD, CPIR, CPDR
;----------------------------------------------------------------
sweep_ed_blocks:
                LD   HL, BUF_A
                LD   DE, BUF_B
                LD   BC, $0010
                LDIR                    ; ED B0

                LD   HL, BUF_A+15
                LD   DE, BUF_B+15
                LD   BC, $0010
                LDDR                    ; ED B8

                LD   HL, BUF_A+8
                LD   DE, BUF_B+8
                LD   BC, $0008
                LDI                     ; ED A0
                LDD                     ; ED A8

                ; Pre-load A with first byte so CPIR finds a match early
                LD   HL, BUF_A
                LD   BC, $0010
                LD   A, (HL)
                CPI                     ; ED A1
                CPD                     ; ED A9

                LD   HL, BUF_A
                LD   BC, $0008
                CPIR                    ; ED B1
                LD   HL, BUF_A+8
                LD   BC, $0008
                CPDR                    ; ED B9
                RET

;----------------------------------------------------------------
; sweep_ed_io_blocks — INI, IND, INIR, INDR, OUTI, OUTD, OTIR, OTDR
;----------------------------------------------------------------
sweep_ed_io_blocks:
                LD   HL, BUF_A
                LD   B, $04
                LD   C, $10
                INI                     ; ED A2
                IND                     ; ED AA
                LD   HL, BUF_A+4
                LD   B, $04
                INIR                    ; ED B2
                LD   HL, BUF_A+8
                LD   B, $04
                INDR                    ; ED BA

                LD   HL, BUF_A
                LD   B, $04
                LD   C, $20
                OUTI                    ; ED A3
                OUTD                    ; ED AB
                LD   HL, BUF_A+4
                LD   B, $04
                OTIR                    ; ED B3
                LD   HL, BUF_A+8
                LD   B, $04
                OTDR                    ; ED BB
                RET

;----------------------------------------------------------------
; sweep_dd_doc — documented DD-prefixed opcodes (IX form)
;
; Covers: ADD IX,rr; LD IX,nn; LD (nn),IX; LD IX,(nn); INC/DEC IX;
;         LD r,(IX+d) and LD (IX+d),r for all r != (HL);
;         LD (IX+d),n; INC/DEC (IX+d); ALU A,(IX+d) for all 8 ALU ops;
;         PUSH IX, POP IX, EX (SP),IX, JP (IX), LD SP,IX.
;----------------------------------------------------------------
sweep_dd_doc:
                LD   IX, IX_BASE
                LD   BC, $1234
                LD   DE, $5678

                ADD  IX, BC             ; DD 09
                ADD  IX, DE             ; DD 19
                ADD  IX, IX             ; DD 29
                ADD  IX, SP             ; DD 39

                LD   IX, IX_BASE
                LD   ($90B0), IX        ; DD 22
                LD   IX, ($90B0)        ; DD 2A
                INC  IX                 ; DD 23
                DEC  IX                 ; DD 2B

                LD   IX, IX_BASE
                LD   B, (IX+0)          ; DD 46
                LD   C, (IX+0)          ; DD 4E
                LD   D, (IX+0)          ; DD 56
                LD   E, (IX+0)          ; DD 5E
                LD   H, (IX+0)          ; DD 66
                LD   L, (IX+0)          ; DD 6E
                LD   A, (IX+0)          ; DD 7E

                LD   IX, IX_BASE
                LD   (IX+0), B          ; DD 70
                LD   (IX+0), C          ; DD 71
                LD   (IX+0), D          ; DD 72
                LD   (IX+0), E          ; DD 73
                LD   (IX+0), H          ; DD 74
                LD   (IX+0), L          ; DD 75
                LD   (IX+0), A          ; DD 77

                LD   (IX+0), $42        ; DD 36 d n
                INC  (IX+0)             ; DD 34
                DEC  (IX+0)             ; DD 35

                ADD  A, (IX+0)          ; DD 86
                ADC  A, (IX+0)          ; DD 8E
                SUB  (IX+0)             ; DD 96
                SBC  A, (IX+0)          ; DD 9E
                AND  (IX+0)             ; DD A6
                XOR  (IX+0)             ; DD AE
                OR   (IX+0)             ; DD B6
                CP   (IX+0)             ; DD BE

                PUSH IX                 ; DD E5
                POP  IX                 ; DD E1
                PUSH IX
                EX   (SP), IX           ; DD E3 (wrapped — operates on our pushed copy)
                POP  IX

                ; LD SP,IX is destructive — save/restore real SP via memory
                LD   ($90D0), SP
                LD   IX, IX_BASE
                LD   SP, IX             ; DD F9
                LD   SP, ($90D0)
                LD   IX, IX_BASE

                LD   IX, _afterjpix
                JP   (IX)               ; DD E9
                NOP
_afterjpix:
                RET

;----------------------------------------------------------------
; sweep_dd_idxhl — undocumented IXH/IXL ops
;
; Covers: INC/DEC IXH, INC/DEC IXL, LD IXH/IXL,n, LD r,IXH/IXL for r in B,C,D,E,A,
;         LD IXH/IXL,r for r in B,C,D,E,IXH,IXL,A,
;         ALU A,IXH/IXL for all 8 ALU ops.
;
; Emitted as raw DEFB to bypass any sjasmplus dialect that doesn't accept
; IXH/IXL mnemonics directly.
;----------------------------------------------------------------
sweep_dd_idxhl:
                LD   IX, IX_BASE
                ; INC/DEC IXH/IXL, LD IXH/IXL,n
                DEFB $DD, $24           ; INC IXH
                DEFB $DD, $25           ; DEC IXH
                DEFB $DD, $26, $42      ; LD IXH,n
                DEFB $DD, $2C           ; INC IXL
                DEFB $DD, $2D           ; DEC IXL
                DEFB $DD, $2E, $84      ; LD IXL,n

                ; LD r, IXH/IXL  (r = B,C,D,E,A; H/L are the regular DD 64/65/6C/6D)
                DEFB $DD, $44           ; LD B, IXH
                DEFB $DD, $45           ; LD B, IXL
                DEFB $DD, $4C           ; LD C, IXH
                DEFB $DD, $4D           ; LD C, IXL
                DEFB $DD, $54           ; LD D, IXH
                DEFB $DD, $55           ; LD D, IXL
                DEFB $DD, $5C           ; LD E, IXH
                DEFB $DD, $5D           ; LD E, IXL
                DEFB $DD, $7C           ; LD A, IXH
                DEFB $DD, $7D           ; LD A, IXL

                ; LD IXH, r  (r = B,C,D,E,IXH,IXL,A)
                DEFB $DD, $60           ; LD IXH, B
                DEFB $DD, $61           ; LD IXH, C
                DEFB $DD, $62           ; LD IXH, D
                DEFB $DD, $63           ; LD IXH, E
                DEFB $DD, $64           ; LD IXH, IXH
                DEFB $DD, $65           ; LD IXH, IXL
                DEFB $DD, $67           ; LD IXH, A

                ; LD IXL, r
                DEFB $DD, $68           ; LD IXL, B
                DEFB $DD, $69           ; LD IXL, C
                DEFB $DD, $6A           ; LD IXL, D
                DEFB $DD, $6B           ; LD IXL, E
                DEFB $DD, $6C           ; LD IXL, IXH
                DEFB $DD, $6D           ; LD IXL, IXL
                DEFB $DD, $6F           ; LD IXL, A

                ; ALU A, IXH/IXL  (8 ops × 2 regs = 16)
                DEFB $DD, $84           ; ADD A, IXH
                DEFB $DD, $85           ; ADD A, IXL
                DEFB $DD, $8C           ; ADC A, IXH
                DEFB $DD, $8D           ; ADC A, IXL
                DEFB $DD, $94           ; SUB IXH
                DEFB $DD, $95           ; SUB IXL
                DEFB $DD, $9C           ; SBC A, IXH
                DEFB $DD, $9D           ; SBC A, IXL
                DEFB $DD, $A4           ; AND IXH
                DEFB $DD, $A5           ; AND IXL
                DEFB $DD, $AC           ; XOR IXH
                DEFB $DD, $AD           ; XOR IXL
                DEFB $DD, $B4           ; OR IXH
                DEFB $DD, $B5           ; OR IXL
                DEFB $DD, $BC           ; CP IXH
                DEFB $DD, $BD           ; CP IXL
                RET

;----------------------------------------------------------------
; sweep_fd_doc — documented FD-prefixed opcodes (IY form, mirror of sweep_dd_doc)
;----------------------------------------------------------------
sweep_fd_doc:
                LD   IY, IY_BASE
                LD   BC, $1234
                LD   DE, $5678

                ADD  IY, BC             ; FD 09
                ADD  IY, DE             ; FD 19
                ADD  IY, IY             ; FD 29
                ADD  IY, SP             ; FD 39

                LD   IY, IY_BASE
                LD   ($90B4), IY        ; FD 22
                LD   IY, ($90B4)        ; FD 2A
                INC  IY                 ; FD 23
                DEC  IY                 ; FD 2B

                LD   IY, IY_BASE
                LD   B, (IY+0)          ; FD 46
                LD   C, (IY+0)
                LD   D, (IY+0)
                LD   E, (IY+0)
                LD   H, (IY+0)
                LD   L, (IY+0)
                LD   A, (IY+0)

                LD   IY, IY_BASE
                LD   (IY+0), B
                LD   (IY+0), C
                LD   (IY+0), D
                LD   (IY+0), E
                LD   (IY+0), H
                LD   (IY+0), L
                LD   (IY+0), A

                LD   (IY+0), $42
                INC  (IY+0)
                DEC  (IY+0)

                ADD  A, (IY+0)
                ADC  A, (IY+0)
                SUB  (IY+0)
                SBC  A, (IY+0)
                AND  (IY+0)
                XOR  (IY+0)
                OR   (IY+0)
                CP   (IY+0)

                PUSH IY                 ; FD E5
                POP  IY                 ; FD E1
                PUSH IY
                EX   (SP), IY           ; FD E3 (wrapped — operates on our pushed copy)
                POP  IY

                ; LD SP,IY is destructive — save/restore real SP via memory
                LD   ($90D0), SP
                LD   IY, IY_BASE
                LD   SP, IY             ; FD F9
                LD   SP, ($90D0)
                LD   IY, IY_BASE

                LD   IY, _afterjpiy
                JP   (IY)               ; FD E9
                NOP
_afterjpiy:
                RET

;----------------------------------------------------------------
; sweep_fd_iyhl — undocumented IYH/IYL ops (mirror of sweep_dd_idxhl)
;----------------------------------------------------------------
sweep_fd_iyhl:
                LD   IY, IY_BASE
                DEFB $FD, $24           ; INC IYH
                DEFB $FD, $25           ; DEC IYH
                DEFB $FD, $26, $42      ; LD IYH,n
                DEFB $FD, $2C           ; INC IYL
                DEFB $FD, $2D           ; DEC IYL
                DEFB $FD, $2E, $84      ; LD IYL,n

                DEFB $FD, $44           ; LD B, IYH
                DEFB $FD, $45           ; LD B, IYL
                DEFB $FD, $4C
                DEFB $FD, $4D
                DEFB $FD, $54
                DEFB $FD, $55
                DEFB $FD, $5C
                DEFB $FD, $5D
                DEFB $FD, $7C
                DEFB $FD, $7D

                DEFB $FD, $60           ; LD IYH, r
                DEFB $FD, $61
                DEFB $FD, $62
                DEFB $FD, $63
                DEFB $FD, $64
                DEFB $FD, $65
                DEFB $FD, $67

                DEFB $FD, $68           ; LD IYL, r
                DEFB $FD, $69
                DEFB $FD, $6A
                DEFB $FD, $6B
                DEFB $FD, $6C
                DEFB $FD, $6D
                DEFB $FD, $6F

                DEFB $FD, $84           ; ALU A, IYH/IYL
                DEFB $FD, $85
                DEFB $FD, $8C
                DEFB $FD, $8D
                DEFB $FD, $94
                DEFB $FD, $95
                DEFB $FD, $9C
                DEFB $FD, $9D
                DEFB $FD, $A4
                DEFB $FD, $A5
                DEFB $FD, $AC
                DEFB $FD, $AD
                DEFB $FD, $B4
                DEFB $FD, $B5
                DEFB $FD, $BC
                DEFB $FD, $BD
                RET

;----------------------------------------------------------------
; sweep_ddcb — all 256 DDCB encodings: $DD $CB d xx for xx in $00..$FF
;
; All ops reference (IX+d). With d=$00 and IX=IX_BASE, every op touches
; mem[$A000] (in scratch area). Some encodings also store the result
; back to a register (the "register-write" undocumented variants where
; the low 3 bits select B/C/D/E/H/L/A).
;
; 256 ops × 4 bytes = 1024 bytes.
;----------------------------------------------------------------
sweep_ddcb:
                LD   IX, IX_BASE
                ; --- $00..$1F (RLC/RRC/RL/RR variants × 8 r) ---
                DEFB $DD,$CB,0,$00, $DD,$CB,0,$01, $DD,$CB,0,$02, $DD,$CB,0,$03
                DEFB $DD,$CB,0,$04, $DD,$CB,0,$05, $DD,$CB,0,$06, $DD,$CB,0,$07
                DEFB $DD,$CB,0,$08, $DD,$CB,0,$09, $DD,$CB,0,$0A, $DD,$CB,0,$0B
                DEFB $DD,$CB,0,$0C, $DD,$CB,0,$0D, $DD,$CB,0,$0E, $DD,$CB,0,$0F
                DEFB $DD,$CB,0,$10, $DD,$CB,0,$11, $DD,$CB,0,$12, $DD,$CB,0,$13
                DEFB $DD,$CB,0,$14, $DD,$CB,0,$15, $DD,$CB,0,$16, $DD,$CB,0,$17
                DEFB $DD,$CB,0,$18, $DD,$CB,0,$19, $DD,$CB,0,$1A, $DD,$CB,0,$1B
                DEFB $DD,$CB,0,$1C, $DD,$CB,0,$1D, $DD,$CB,0,$1E, $DD,$CB,0,$1F
                ; --- $20..$3F (SLA/SRA/SLL/SRL × 8 r) ---
                DEFB $DD,$CB,0,$20, $DD,$CB,0,$21, $DD,$CB,0,$22, $DD,$CB,0,$23
                DEFB $DD,$CB,0,$24, $DD,$CB,0,$25, $DD,$CB,0,$26, $DD,$CB,0,$27
                DEFB $DD,$CB,0,$28, $DD,$CB,0,$29, $DD,$CB,0,$2A, $DD,$CB,0,$2B
                DEFB $DD,$CB,0,$2C, $DD,$CB,0,$2D, $DD,$CB,0,$2E, $DD,$CB,0,$2F
                DEFB $DD,$CB,0,$30, $DD,$CB,0,$31, $DD,$CB,0,$32, $DD,$CB,0,$33
                DEFB $DD,$CB,0,$34, $DD,$CB,0,$35, $DD,$CB,0,$36, $DD,$CB,0,$37
                DEFB $DD,$CB,0,$38, $DD,$CB,0,$39, $DD,$CB,0,$3A, $DD,$CB,0,$3B
                DEFB $DD,$CB,0,$3C, $DD,$CB,0,$3D, $DD,$CB,0,$3E, $DD,$CB,0,$3F
                ; --- $40..$7F (BIT n,(IX+d) — register slot is don't-care) ---
                DEFB $DD,$CB,0,$40, $DD,$CB,0,$41, $DD,$CB,0,$42, $DD,$CB,0,$43
                DEFB $DD,$CB,0,$44, $DD,$CB,0,$45, $DD,$CB,0,$46, $DD,$CB,0,$47
                DEFB $DD,$CB,0,$48, $DD,$CB,0,$49, $DD,$CB,0,$4A, $DD,$CB,0,$4B
                DEFB $DD,$CB,0,$4C, $DD,$CB,0,$4D, $DD,$CB,0,$4E, $DD,$CB,0,$4F
                DEFB $DD,$CB,0,$50, $DD,$CB,0,$51, $DD,$CB,0,$52, $DD,$CB,0,$53
                DEFB $DD,$CB,0,$54, $DD,$CB,0,$55, $DD,$CB,0,$56, $DD,$CB,0,$57
                DEFB $DD,$CB,0,$58, $DD,$CB,0,$59, $DD,$CB,0,$5A, $DD,$CB,0,$5B
                DEFB $DD,$CB,0,$5C, $DD,$CB,0,$5D, $DD,$CB,0,$5E, $DD,$CB,0,$5F
                DEFB $DD,$CB,0,$60, $DD,$CB,0,$61, $DD,$CB,0,$62, $DD,$CB,0,$63
                DEFB $DD,$CB,0,$64, $DD,$CB,0,$65, $DD,$CB,0,$66, $DD,$CB,0,$67
                DEFB $DD,$CB,0,$68, $DD,$CB,0,$69, $DD,$CB,0,$6A, $DD,$CB,0,$6B
                DEFB $DD,$CB,0,$6C, $DD,$CB,0,$6D, $DD,$CB,0,$6E, $DD,$CB,0,$6F
                DEFB $DD,$CB,0,$70, $DD,$CB,0,$71, $DD,$CB,0,$72, $DD,$CB,0,$73
                DEFB $DD,$CB,0,$74, $DD,$CB,0,$75, $DD,$CB,0,$76, $DD,$CB,0,$77
                DEFB $DD,$CB,0,$78, $DD,$CB,0,$79, $DD,$CB,0,$7A, $DD,$CB,0,$7B
                DEFB $DD,$CB,0,$7C, $DD,$CB,0,$7D, $DD,$CB,0,$7E, $DD,$CB,0,$7F
                ; --- $80..$BF (RES n,(IX+d) [→ r]) ---
                DEFB $DD,$CB,0,$80, $DD,$CB,0,$81, $DD,$CB,0,$82, $DD,$CB,0,$83
                DEFB $DD,$CB,0,$84, $DD,$CB,0,$85, $DD,$CB,0,$86, $DD,$CB,0,$87
                DEFB $DD,$CB,0,$88, $DD,$CB,0,$89, $DD,$CB,0,$8A, $DD,$CB,0,$8B
                DEFB $DD,$CB,0,$8C, $DD,$CB,0,$8D, $DD,$CB,0,$8E, $DD,$CB,0,$8F
                DEFB $DD,$CB,0,$90, $DD,$CB,0,$91, $DD,$CB,0,$92, $DD,$CB,0,$93
                DEFB $DD,$CB,0,$94, $DD,$CB,0,$95, $DD,$CB,0,$96, $DD,$CB,0,$97
                DEFB $DD,$CB,0,$98, $DD,$CB,0,$99, $DD,$CB,0,$9A, $DD,$CB,0,$9B
                DEFB $DD,$CB,0,$9C, $DD,$CB,0,$9D, $DD,$CB,0,$9E, $DD,$CB,0,$9F
                DEFB $DD,$CB,0,$A0, $DD,$CB,0,$A1, $DD,$CB,0,$A2, $DD,$CB,0,$A3
                DEFB $DD,$CB,0,$A4, $DD,$CB,0,$A5, $DD,$CB,0,$A6, $DD,$CB,0,$A7
                DEFB $DD,$CB,0,$A8, $DD,$CB,0,$A9, $DD,$CB,0,$AA, $DD,$CB,0,$AB
                DEFB $DD,$CB,0,$AC, $DD,$CB,0,$AD, $DD,$CB,0,$AE, $DD,$CB,0,$AF
                DEFB $DD,$CB,0,$B0, $DD,$CB,0,$B1, $DD,$CB,0,$B2, $DD,$CB,0,$B3
                DEFB $DD,$CB,0,$B4, $DD,$CB,0,$B5, $DD,$CB,0,$B6, $DD,$CB,0,$B7
                DEFB $DD,$CB,0,$B8, $DD,$CB,0,$B9, $DD,$CB,0,$BA, $DD,$CB,0,$BB
                DEFB $DD,$CB,0,$BC, $DD,$CB,0,$BD, $DD,$CB,0,$BE, $DD,$CB,0,$BF
                ; --- $C0..$FF (SET n,(IX+d) [→ r]) ---
                DEFB $DD,$CB,0,$C0, $DD,$CB,0,$C1, $DD,$CB,0,$C2, $DD,$CB,0,$C3
                DEFB $DD,$CB,0,$C4, $DD,$CB,0,$C5, $DD,$CB,0,$C6, $DD,$CB,0,$C7
                DEFB $DD,$CB,0,$C8, $DD,$CB,0,$C9, $DD,$CB,0,$CA, $DD,$CB,0,$CB
                DEFB $DD,$CB,0,$CC, $DD,$CB,0,$CD, $DD,$CB,0,$CE, $DD,$CB,0,$CF
                DEFB $DD,$CB,0,$D0, $DD,$CB,0,$D1, $DD,$CB,0,$D2, $DD,$CB,0,$D3
                DEFB $DD,$CB,0,$D4, $DD,$CB,0,$D5, $DD,$CB,0,$D6, $DD,$CB,0,$D7
                DEFB $DD,$CB,0,$D8, $DD,$CB,0,$D9, $DD,$CB,0,$DA, $DD,$CB,0,$DB
                DEFB $DD,$CB,0,$DC, $DD,$CB,0,$DD, $DD,$CB,0,$DE, $DD,$CB,0,$DF
                DEFB $DD,$CB,0,$E0, $DD,$CB,0,$E1, $DD,$CB,0,$E2, $DD,$CB,0,$E3
                DEFB $DD,$CB,0,$E4, $DD,$CB,0,$E5, $DD,$CB,0,$E6, $DD,$CB,0,$E7
                DEFB $DD,$CB,0,$E8, $DD,$CB,0,$E9, $DD,$CB,0,$EA, $DD,$CB,0,$EB
                DEFB $DD,$CB,0,$EC, $DD,$CB,0,$ED, $DD,$CB,0,$EE, $DD,$CB,0,$EF
                DEFB $DD,$CB,0,$F0, $DD,$CB,0,$F1, $DD,$CB,0,$F2, $DD,$CB,0,$F3
                DEFB $DD,$CB,0,$F4, $DD,$CB,0,$F5, $DD,$CB,0,$F6, $DD,$CB,0,$F7
                DEFB $DD,$CB,0,$F8, $DD,$CB,0,$F9, $DD,$CB,0,$FA, $DD,$CB,0,$FB
                DEFB $DD,$CB,0,$FC, $DD,$CB,0,$FD, $DD,$CB,0,$FE, $DD,$CB,0,$FF
                RET

;----------------------------------------------------------------
; sweep_fdcb — all 256 FDCB encodings: $FD $CB d xx for xx in $00..$FF
;----------------------------------------------------------------
sweep_fdcb:
                LD   IY, IY_BASE
                DEFB $FD,$CB,0,$00, $FD,$CB,0,$01, $FD,$CB,0,$02, $FD,$CB,0,$03
                DEFB $FD,$CB,0,$04, $FD,$CB,0,$05, $FD,$CB,0,$06, $FD,$CB,0,$07
                DEFB $FD,$CB,0,$08, $FD,$CB,0,$09, $FD,$CB,0,$0A, $FD,$CB,0,$0B
                DEFB $FD,$CB,0,$0C, $FD,$CB,0,$0D, $FD,$CB,0,$0E, $FD,$CB,0,$0F
                DEFB $FD,$CB,0,$10, $FD,$CB,0,$11, $FD,$CB,0,$12, $FD,$CB,0,$13
                DEFB $FD,$CB,0,$14, $FD,$CB,0,$15, $FD,$CB,0,$16, $FD,$CB,0,$17
                DEFB $FD,$CB,0,$18, $FD,$CB,0,$19, $FD,$CB,0,$1A, $FD,$CB,0,$1B
                DEFB $FD,$CB,0,$1C, $FD,$CB,0,$1D, $FD,$CB,0,$1E, $FD,$CB,0,$1F
                DEFB $FD,$CB,0,$20, $FD,$CB,0,$21, $FD,$CB,0,$22, $FD,$CB,0,$23
                DEFB $FD,$CB,0,$24, $FD,$CB,0,$25, $FD,$CB,0,$26, $FD,$CB,0,$27
                DEFB $FD,$CB,0,$28, $FD,$CB,0,$29, $FD,$CB,0,$2A, $FD,$CB,0,$2B
                DEFB $FD,$CB,0,$2C, $FD,$CB,0,$2D, $FD,$CB,0,$2E, $FD,$CB,0,$2F
                DEFB $FD,$CB,0,$30, $FD,$CB,0,$31, $FD,$CB,0,$32, $FD,$CB,0,$33
                DEFB $FD,$CB,0,$34, $FD,$CB,0,$35, $FD,$CB,0,$36, $FD,$CB,0,$37
                DEFB $FD,$CB,0,$38, $FD,$CB,0,$39, $FD,$CB,0,$3A, $FD,$CB,0,$3B
                DEFB $FD,$CB,0,$3C, $FD,$CB,0,$3D, $FD,$CB,0,$3E, $FD,$CB,0,$3F
                DEFB $FD,$CB,0,$40, $FD,$CB,0,$41, $FD,$CB,0,$42, $FD,$CB,0,$43
                DEFB $FD,$CB,0,$44, $FD,$CB,0,$45, $FD,$CB,0,$46, $FD,$CB,0,$47
                DEFB $FD,$CB,0,$48, $FD,$CB,0,$49, $FD,$CB,0,$4A, $FD,$CB,0,$4B
                DEFB $FD,$CB,0,$4C, $FD,$CB,0,$4D, $FD,$CB,0,$4E, $FD,$CB,0,$4F
                DEFB $FD,$CB,0,$50, $FD,$CB,0,$51, $FD,$CB,0,$52, $FD,$CB,0,$53
                DEFB $FD,$CB,0,$54, $FD,$CB,0,$55, $FD,$CB,0,$56, $FD,$CB,0,$57
                DEFB $FD,$CB,0,$58, $FD,$CB,0,$59, $FD,$CB,0,$5A, $FD,$CB,0,$5B
                DEFB $FD,$CB,0,$5C, $FD,$CB,0,$5D, $FD,$CB,0,$5E, $FD,$CB,0,$5F
                DEFB $FD,$CB,0,$60, $FD,$CB,0,$61, $FD,$CB,0,$62, $FD,$CB,0,$63
                DEFB $FD,$CB,0,$64, $FD,$CB,0,$65, $FD,$CB,0,$66, $FD,$CB,0,$67
                DEFB $FD,$CB,0,$68, $FD,$CB,0,$69, $FD,$CB,0,$6A, $FD,$CB,0,$6B
                DEFB $FD,$CB,0,$6C, $FD,$CB,0,$6D, $FD,$CB,0,$6E, $FD,$CB,0,$6F
                DEFB $FD,$CB,0,$70, $FD,$CB,0,$71, $FD,$CB,0,$72, $FD,$CB,0,$73
                DEFB $FD,$CB,0,$74, $FD,$CB,0,$75, $FD,$CB,0,$76, $FD,$CB,0,$77
                DEFB $FD,$CB,0,$78, $FD,$CB,0,$79, $FD,$CB,0,$7A, $FD,$CB,0,$7B
                DEFB $FD,$CB,0,$7C, $FD,$CB,0,$7D, $FD,$CB,0,$7E, $FD,$CB,0,$7F
                DEFB $FD,$CB,0,$80, $FD,$CB,0,$81, $FD,$CB,0,$82, $FD,$CB,0,$83
                DEFB $FD,$CB,0,$84, $FD,$CB,0,$85, $FD,$CB,0,$86, $FD,$CB,0,$87
                DEFB $FD,$CB,0,$88, $FD,$CB,0,$89, $FD,$CB,0,$8A, $FD,$CB,0,$8B
                DEFB $FD,$CB,0,$8C, $FD,$CB,0,$8D, $FD,$CB,0,$8E, $FD,$CB,0,$8F
                DEFB $FD,$CB,0,$90, $FD,$CB,0,$91, $FD,$CB,0,$92, $FD,$CB,0,$93
                DEFB $FD,$CB,0,$94, $FD,$CB,0,$95, $FD,$CB,0,$96, $FD,$CB,0,$97
                DEFB $FD,$CB,0,$98, $FD,$CB,0,$99, $FD,$CB,0,$9A, $FD,$CB,0,$9B
                DEFB $FD,$CB,0,$9C, $FD,$CB,0,$9D, $FD,$CB,0,$9E, $FD,$CB,0,$9F
                DEFB $FD,$CB,0,$A0, $FD,$CB,0,$A1, $FD,$CB,0,$A2, $FD,$CB,0,$A3
                DEFB $FD,$CB,0,$A4, $FD,$CB,0,$A5, $FD,$CB,0,$A6, $FD,$CB,0,$A7
                DEFB $FD,$CB,0,$A8, $FD,$CB,0,$A9, $FD,$CB,0,$AA, $FD,$CB,0,$AB
                DEFB $FD,$CB,0,$AC, $FD,$CB,0,$AD, $FD,$CB,0,$AE, $FD,$CB,0,$AF
                DEFB $FD,$CB,0,$B0, $FD,$CB,0,$B1, $FD,$CB,0,$B2, $FD,$CB,0,$B3
                DEFB $FD,$CB,0,$B4, $FD,$CB,0,$B5, $FD,$CB,0,$B6, $FD,$CB,0,$B7
                DEFB $FD,$CB,0,$B8, $FD,$CB,0,$B9, $FD,$CB,0,$BA, $FD,$CB,0,$BB
                DEFB $FD,$CB,0,$BC, $FD,$CB,0,$BD, $FD,$CB,0,$BE, $FD,$CB,0,$BF
                DEFB $FD,$CB,0,$C0, $FD,$CB,0,$C1, $FD,$CB,0,$C2, $FD,$CB,0,$C3
                DEFB $FD,$CB,0,$C4, $FD,$CB,0,$C5, $FD,$CB,0,$C6, $FD,$CB,0,$C7
                DEFB $FD,$CB,0,$C8, $FD,$CB,0,$C9, $FD,$CB,0,$CA, $FD,$CB,0,$CB
                DEFB $FD,$CB,0,$CC, $FD,$CB,0,$CD, $FD,$CB,0,$CE, $FD,$CB,0,$CF
                DEFB $FD,$CB,0,$D0, $FD,$CB,0,$D1, $FD,$CB,0,$D2, $FD,$CB,0,$D3
                DEFB $FD,$CB,0,$D4, $FD,$CB,0,$D5, $FD,$CB,0,$D6, $FD,$CB,0,$D7
                DEFB $FD,$CB,0,$D8, $FD,$CB,0,$D9, $FD,$CB,0,$DA, $FD,$CB,0,$DB
                DEFB $FD,$CB,0,$DC, $FD,$CB,0,$DD, $FD,$CB,0,$DE, $FD,$CB,0,$DF
                DEFB $FD,$CB,0,$E0, $FD,$CB,0,$E1, $FD,$CB,0,$E2, $FD,$CB,0,$E3
                DEFB $FD,$CB,0,$E4, $FD,$CB,0,$E5, $FD,$CB,0,$E6, $FD,$CB,0,$E7
                DEFB $FD,$CB,0,$E8, $FD,$CB,0,$E9, $FD,$CB,0,$EA, $FD,$CB,0,$EB
                DEFB $FD,$CB,0,$EC, $FD,$CB,0,$ED, $FD,$CB,0,$EE, $FD,$CB,0,$EF
                DEFB $FD,$CB,0,$F0, $FD,$CB,0,$F1, $FD,$CB,0,$F2, $FD,$CB,0,$F3
                DEFB $FD,$CB,0,$F4, $FD,$CB,0,$F5, $FD,$CB,0,$F6, $FD,$CB,0,$F7
                DEFB $FD,$CB,0,$F8, $FD,$CB,0,$F9, $FD,$CB,0,$FA, $FD,$CB,0,$FB
                DEFB $FD,$CB,0,$FC, $FD,$CB,0,$FD, $FD,$CB,0,$FE, $FD,$CB,0,$FF
                RET

;================================================================
; loop_top — chained mixer body (runs N times for benchmark bulk)
;
; Same body as the previous revision: smart-chained ops representative of
; typical Z80 workloads. Coverage of every encoding is handled above by
; sweep_all (run once during init); this loop bulks up the HC count for
; meaningful timing.
;================================================================
loop_top:
                ; ── 8-bit LD r,r' chain ──
                LD   A, B
                INC  A
                LD   D, A
                LD   E, B
                INC  DE
                LD   A, E
                LD   C, A
                LD   A, H
                XOR  C
                LD   B, A
                LD   A, L
                OR   B
                LD   H, A
                LD   L, B

                ; ── 8-bit ALU chain ──
                LD   A, $5A
                ADD  A, B
                ADC  A, C
                SUB  D
                SBC  A, E
                AND  H
                XOR  L
                OR   B
                CP   C
                ADD  A, $37
                ADC  A, $10
                SUB  $05
                SBC  A, $0F
                AND  $F0
                XOR  $55
                OR   $0C
                CP   $80

                ; ── ALU A,(HL) chain ──
                LD   HL, BUF_A
                ADD  A, (HL) : INC HL
                ADC  A, (HL) : INC HL
                SUB  (HL)    : INC HL
                SBC  A, (HL) : INC HL
                AND  (HL)    : INC HL
                XOR  (HL)    : INC HL
                OR   (HL)    : INC HL
                CP   (HL)

                ; ── 16-bit ALU ──
                LD   BC, $1234
                LD   DE, $5678
                LD   HL, $9000
                ADD  HL, BC
                ADD  HL, DE
                ADC  HL, BC
                SBC  HL, DE
                ADD  HL, HL
                ADD  HL, SP

                ; ── exchanges ──
                EX   DE, HL
                EX   AF, AF'
                EXX
                EXX
                EX   AF, AF'
                EX   DE, HL

                ; ── rotates A and CB rot/shift on regs ──
                RLCA
                RRCA
                RLA
                RRA
                RLC  B
                RRC  C
                RL   D
                RR   E
                SLA  H
                SRA  L
                SRL  B

                ; ── BIT/SET/RES samples ──
                BIT  3, A
                SET  0, C
                RES  2, E
                LD   HL, BUF_A
                BIT  4, (HL)
                SET  1, (HL)
                RES  3, (HL)

                ; ── IX/IY base ops ──
                LD   IX, IX_BASE
                LD   IY, IY_BASE
                ADD  IX, BC
                ADD  IY, DE
                LD   IX, IX_BASE
                LD   IY, IY_BASE
                LD   (IX+0), A
                LD   B, (IX+0)
                ADD  A, (IY+0)
                INC  (IX+0)

                ; ── small block ops ──
                LD   HL, BUF_A
                LD   DE, BUF_B
                LD   BC, $0008
                LDIR

                ; ── IO ──
                LD   A, $42
                OUT  ($80), A
                IN   A, ($80)

                ; ── PUSH/POP ──
                PUSH AF
                PUSH BC
                PUSH DE
                PUSH HL
                POP  HL
                POP  DE
                POP  BC
                POP  AF

                ; ── misc ──
                DAA
                CPL
                SCF
                CCF
                NOP

                ; ── counter dec, loop ──
                LD   A, (COUNTER_ADDR)
                DEC  A
                LD   (COUNTER_ADDR), A
                JP   NZ, loop_top

                ; ── dirty F' deterministically before snapshot ──
                ; OR A sets flags from A without changing A, giving a deterministic F'.
                EX   AF, AF'
                OR   A
                EX   AF, AF'

                ; ── tail: write sentinel, then trap ──
                LD   A, SENT_VAL
                LD   (SENTINEL_ADDR), A
end:
                JR   end
