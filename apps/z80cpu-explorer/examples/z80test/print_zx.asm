;
; Minimal ZX Spectrum 48K ROM output emulation.
;
; Implements:
;   RST 10h  - print character from A
;   1601h    - select output channel / reset output buffer pointer
; Output is redirected to a memory buffer starting at 4000h.
; Carriage return advances the output pointer to the next 32-byte row.
;

cr          equ     13


            org     0

            jp      8000h               ; jump to program entry


            org     10h                 ; simulate ZX ROM RST 10h

            jp      zx_print


            org     40h

zx_print:
            cp      0
            ret     z                   ; exit at NUL terminator

            ld      de, (pr_addr)

            cp      cr
            jr      z, zx_newline

            ld      (de), a             ; write character to output buffer
            inc     de
            ld      (pr_addr), de
            ret

zx_newline:
            ld      a, 1fh              ; advance to next 32-byte row
            or      e
            ld      e, a
            inc     de
            ld      (pr_addr), de
            ret


            org     15ffh

pr_addr     dw      4000h               ; output buffer pointer

            org     1601h               ; simulate ROM channel selection

            ld      de, 4000h           ; reset output buffer
            ld      (pr_addr), de
            ret