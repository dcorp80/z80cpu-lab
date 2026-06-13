;
; Mandelbrot set for Z80
;
; Original version:
;   https://rosettacode.org/wiki/Mandelbrot_set#Z80_Assembly
;
; CP/M/color adaptation by J.B. Langston:
;   https://gist.github.com/jblang/3b17598ccfa0f7e5cca79ad826a399a9
;
; Further adapted for this emulator/platform by dcorp80
; Assemble with sjasmplus

            org     0
            jp      start

pr_addr     dw      4000h               ; Output buffer. Observe Mandelbrot ASCII output starting at 4000h.

            org     5                   ; Minimal CP/M BDOS emulation:
                                        ;   C=2  -> output character from E
                                        ;   C=9  -> output '$'-terminated string from DE
bdos:
            ld      hl, (pr_addr)
            ld      a, prints
            cp      c
            jr      z, prstr

            ld      (hl), e             ; CONOUT: write character from E
            inc     hl
            ld      (pr_addr), hl
            ret

prstr:
            ex      de, hl              ; PRINTS: DE points to '$'-terminated string

pr_loop:
            ld      a, eos
            cp      (hl)
            jr      z, pr_loop_end

            ld      a, cr
            cp      (hl)
            jr      z, nl

            ldi                         ; copy character to output buffer
            jr      pr_loop

pr_loop_end:
            ld      (pr_addr), de
            ret

nl:
            ld      a, 7fh              ; move output pointer to next 128-byte row
            or      e
            ld      e, a
            inc     de
            inc     hl
            inc     hl                  ; skip following LF
            jr      pr_loop


conout          equ     2
prints          equ     9
cr              equ     13
lf              equ     10
esc             equ     27
eos             equ     '$'
scale           equ     256
divergent       equ     scale * 4

iteration_max   defb    10

x               defw    0
x_start         defw    -2 * scale
x_end           defw    1 * scale
x_step          defw    4 * scale / 110

y               defw    -1 * scale
y_end           defw    1 * scale
y_step          defw    1 * scale / 10

z_0             defw    0
z_1             defw    0
scratch_0       defw    0

z_0_square_high defw    0
z_0_square_low  defw    0
z_1_square_high defw    0
z_1_square_low  defw    0

chars           defb    " .-+*=#@"

welcome         defb    "Generating a Mandelbrot set"
crlf            defb    cr, lf, eos
finished        defb    esc, "Computation finished.", cr, lf, eos


start:
            di                          ; standalone demo: disable interrupts
            ld      de, welcome
            ld      c, prints
            call    bdos

outer_loop:
            ld      hl, (y_end)
            ld      de, (y)
            and     a
            sbc     hl, de
            jp      m, mandel_end

            ld      hl, (x_start)
            ld      (x), hl

inner_loop:
            ld      hl, (x_end)
            ld      de, (x)
            and     a
            sbc     hl, de
            jp      m, inner_loop_end

            ld      hl, 0
            ld      (z_0), hl
            ld      (z_1), hl

            ld      a, (iteration_max)
            ld      b, a

iteration_loop:
            push    bc

            ; DEHL = z_1 * z_1
            ld      de, (z_1)
            ld      b, d
            ld      c, e
            call    mul_16
            ld      (z_1_square_low), hl
            ld      (z_1_square_high), de

            ; DEHL = z_0 * z_0
            ld      de, (z_0)
            ld      b, d
            ld      c, e
            call    mul_16
            ld      (z_0_square_low), hl
            ld      (z_0_square_high), de

            ; z_2 = (z_0 * z_0 - z_1 * z_1) / scale
            and     a
            ld      bc, (z_1_square_low)
            sbc     hl, bc
            ld      (scratch_0), hl

            ld      h, d
            ld      l, e
            ld      bc, (z_1_square_high)
            sbc     hl, bc

            ld      bc, (scratch_0)
            ld      c, b
            ld      b, l
            push    bc

            ; z_3 = 2 * z_0 * z_1 / scale
            ld      hl, (z_0)
            add     hl, hl
            ld      d, h
            ld      e, l
            ld      bc, (z_1)
            call    mul_16

            ld      b, e
            ld      c, h

            ; z_1 = z_3 + y
            ld      hl, (y)
            add     hl, bc
            ld      (z_1), hl

            ; z_0 = z_2 + x
            pop     bc
            ld      hl, (x)
            add     hl, bc
            ld      (z_0), hl

            ; if z_0^2 / scale + z_1^2 / scale > 4 * scale, break
            ld      hl, (z_0_square_low)
            ld      de, (z_1_square_low)
            add     hl, de
            ld      b, h
            ld      c, l

            ld      hl, (z_0_square_high)
            ld      de, (z_1_square_high)
            adc     hl, de

            ld      h, l
            ld      l, b

            ld      bc, divergent
            and     a
            sbc     hl, bc

            jp      c, iteration_dec

            pop     bc
            jr      iteration_end

iteration_dec:
            pop     bc
            djnz    iteration_loop

iteration_end:
            call    asciipixel

            ld      c, conout
            call    bdos

            ld      de, (x_step)
            ld      hl, (x)
            add     hl, de
            ld      (x), hl

            jp      inner_loop

inner_loop_end:
            ld      de, crlf
            ld      c, prints
            call    bdos

            ld      de, (y_step)
            ld      hl, (y)
            add     hl, de
            ld      (y), hl

            jp      outer_loop

mandel_end:
            ld      de, finished
            ld      c, prints
            call    bdos

            halt                        ; terminate execution (emulator/demo)
            ret                         ; return to CP/M if HALT is ignored

asciipixel:
            ld      a, b
            and     $7
            sbc     hl, hl
            ld      l, a

            ld      de, chars
            add     hl, de
            ld      e, (hl)
            ret


;
; Compute DEHL = BC * DE signed.
;
mul_16:
            xor     a
            bit     7, b
            jr      z, bc_positive

            sub     c
            ld      c, a
            ld      a, 0
            sbc     a, b
            ld      b, a
            scf

bc_positive:
            bit     7, d
            jr      z, de_positive

            push    af
            xor     a
            sub     e
            ld      e, a
            ld      a, 0
            sbc     a, d
            ld      d, a
            pop     af
            ccf

de_positive:
            push    af
            and     a
            sbc     hl, hl

            ld      a, 16

mul_16_loop:
            add     hl, hl
            rl      e
            rl      d
            jr      nc, mul_16_exit

            add     hl, bc
            jr      nc, mul_16_exit

            inc     de

mul_16_exit:
            dec     a
            jr      nz, mul_16_loop

            pop     af
            ret     nc

            xor     a
            sub     l
            ld      l, a
            ld      a, 0
            sbc     a, h
            ld      h, a
            ld      a, 0
            sbc     a, e
            ld      e, a
            ld      a, 0
            sbc     a, d
            ld      d, a
            ret
