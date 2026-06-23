;
; Rule 30 cellular automaton — INT-paced screen output
; (double-buffered; ISR throttles at the row boundary)
;
; Written by dcorp80 for the z80cpu-lab explorer
;
; Assemble with sjasmplus:
;   sjasmplus rule30.asm --raw=rule30.bin
;
; Two cooperative tasks scheduled by the explorer's INT generator:
;   - ISR (consumer, IM 1) — emits one cell per interrupt; on row-
;     end sets ROW_DONE=1 and throttles itself (early return) until
;     main clears it.
;   - Main (producer) — computes the next generation, HALTs until
;     ROW_DONE=1, swaps DISPLAY_PTR <-> COMPUTE_PTR, clears ROW_DONE.
;
; The ISR uses the shadow register set (`ex af, af'` + `exx`) for
; context save — ~80 T-states shorter than four push/pops, and safe
; here because main never touches the shadows.
;
; Rule:   next[i] = cells[i-1] XOR (cells[i] OR cells[i+1])
; Width:  128 cells, wrap-around (mask with WIDTH-1; WIDTH is 2^n)
; Seed:   single 1 at the middle of the row
; Screen: $4000..$BFFF (256 rows), cursor wraps back to $4000 after that
;
; With WIDTH = 128 the explorer's Memory pane (WATCH=4000, WIDTH=128)
; renders each CA generation as exactly one memory row.
;
; See README.md for the full pace/throttle/race-freedom rationale.
;

            org     0
            jp      start

;------------------------------------------------------------
; IM 1 vector
;------------------------------------------------------------
            org     $0038
            jp      isr_body

;------------------------------------------------------------
; NMI vector — no-op (defensive against the explorer's nNMI checkbox).
;------------------------------------------------------------
            org     $0066
            retn

;------------------------------------------------------------
; Equates and data
;------------------------------------------------------------
WIDTH       equ     128             ; cells per row (must be a power of 2)
CHAR_ON     equ     '^'
CHAR_OFF    equ     $20             ; ASCII space
SCREEN      equ     $4000           ; first byte of memory-mapped screen
SCREEN_END  equ     $C000           ; cursor wraps back to SCREEN here

; Two row buffers, allocated contiguously so init can clear both
; with one LDIR.
BUF_A       ds      WIDTH
BUF_B       ds      WIDTH

DISPLAY_PTR dw      0               ; buffer the ISR is currently displaying
COMPUTE_PTR dw      0               ; buffer main is computing into
CURSOR_VAR  dw      0               ; next byte to write in the screen
COL_VAR     db      0               ; current column 0..WIDTH-1
ROW_DONE    db      0               ; 1 = end-of-row hit; ISR throttled
                                    ;     until main does the swap

;------------------------------------------------------------
start:
            di
            ld      sp, $FFF0

            ; Clear both buffers in one LDIR — BUF_A/BUF_B are contiguous
            ld      hl, BUF_A
            ld      de, BUF_A + 1
            ld      bc, 2*WIDTH - 1
            ld      (hl), 0
            ldir

            ; Seed: single 1 at the middle of BUF_A
            ld      a, 1
            ld      (BUF_A + WIDTH/2), a

            ; Pointers: ISR displays BUF_A, main computes into BUF_B
            ld      hl, BUF_A
            ld      (DISPLAY_PTR), hl
            ld      hl, BUF_B
            ld      (COMPUTE_PTR), hl

            ld      hl, SCREEN
            ld      (CURSOR_VAR), hl
            xor     a
            ld      (COL_VAR), a
            ld      (ROW_DONE), a

            im      1
            ei

;------------------------------------------------------------
; main_loop — producer task.
;   Compute the next generation, HALT until the ISR signals end-of-
;   row, then swap pointers and clear ROW_DONE to release the ISR.
;------------------------------------------------------------
main_loop:
            call    rule30_step

wait_row:
            halt
            ld      a, (ROW_DONE)
            or      a
            jr      z, wait_row

            ; ROW_DONE = 1 here, so the ISR is throttled. We can update
            ; both pointers without any race — no partial-state read
            ; can possibly happen.
            ld      hl, (DISPLAY_PTR)
            ld      de, (COMPUTE_PTR)
            ld      (DISPLAY_PTR), de
            ld      (COMPUTE_PTR), hl

            xor     a
            ld      (ROW_DONE), a   ; release the ISR

            jr      main_loop

;------------------------------------------------------------
; isr_body — IM 1 consumer task.
;   Throttle (return early) if ROW_DONE = 1 — main hasn't swapped yet.
;   Otherwise emit one cell, advance the cursor, and on row-end
;   signal main and reset col.
;------------------------------------------------------------
isr_body:
            ex      af, af'
            exx

            ; Throttle if main hasn't swapped yet.
            ld      a, (ROW_DONE)
            or      a
            jr      nz, isr_done

            ; Look up *DISPLAY_PTR + COL, pick a character
            ld      a, (COL_VAR)
            ld      e, a
            ld      d, 0
            ld      hl, (DISPLAY_PTR)
            add     hl, de
            ld      a, (hl)
            or      a
            ld      a, CHAR_OFF
            jr      z, isr_emit
            ld      a, CHAR_ON
isr_emit:
            ld      hl, (CURSOR_VAR)
            ld      (hl), a         ; -> memory-mapped screen
            inc     hl
            ld      a, h
            cp      $C0             ; HIGH(SCREEN_END)
            jr      c, isr_cursor_ok
            ld      hl, SCREEN      ; wrap cursor back to top
isr_cursor_ok:
            ld      (CURSOR_VAR), hl

            ; Advance column; on row-end, signal main and reset col
            ld      a, (COL_VAR)
            inc     a
            cp      WIDTH
            jr      nz, isr_save_col

            ld      a, 1
            ld      (ROW_DONE), a   ; signal main + arm the throttle
            xor     a               ; col := 0

isr_save_col:
            ld      (COL_VAR), a

isr_done:
            exx
            ex      af, af'
            ei
            reti

;------------------------------------------------------------
; rule30_step — write the next generation into *COMPUTE_PTR using
;   *DISPLAY_PTR as the previous generation, with wrap-around.
;   No final LDIR: double-buffering means main's pointer swap is the
;   "promote" step.
;------------------------------------------------------------
rule30_step:
            ld      b, 0            ; B = current cell index i
r30_loop:
            ld      a, b
            dec     a
            and     WIDTH - 1
            call    load_cell       ; A = src[(i-1) & mask]
            ld      c, a            ; C := left

            ld      a, b
            call    load_cell       ; A = src[i]
            ld      d, a            ; D := center

            ld      a, b
            inc     a
            and     WIDTH - 1
            call    load_cell       ; A = src[(i+1) & mask] (right)

            or      d               ; A = center OR right
            xor     c               ; A = left XOR (center OR right)

            ld      l, b
            ld      h, 0
            ld      de, (COMPUTE_PTR)
            add     hl, de
            ld      (hl), a         ; (*COMPUTE_PTR)[i] := result

            inc     b
            ld      a, b
            cp      WIDTH
            jr      nz, r30_loop
            ret

;------------------------------------------------------------
; load_cell — A := (*DISPLAY_PTR)[A & mask].
;   Caller has already masked A. Clobbers HL; preserves BC, DE.
;------------------------------------------------------------
load_cell:
            push    de
            ld      e, a
            ld      d, 0
            ld      hl, (DISPLAY_PTR)
            add     hl, de
            ld      a, (hl)
            pop     de
            ret
