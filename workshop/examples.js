export const EXAMPLES = [
  {id:'add',name:'01 / Hello, bytes',label:'Two numbers. One instruction.',entry:0,args:['20','22'],source:`; Two parameters enter. Forty-two leaves.
; Click a gutter dot to set a breakpoint.

EXP "add" 00

FN 00
  PAR 00
  PAR 01
  RES

  GET 00       ; first parameter → stack
  GET 01       ; second parameter → stack
  ADD          ; pop two, push their sum
  RET
END
`},
  {id:'factorial',name:'02 / The little loop',label:'Factorial with structured branches.',entry:0,args:['5'],source:`; Factorial. BR 0 repeats the loop.
; BRIF 1 escapes its enclosing block.

EXP "factorial" 00

FN 00
  PAR 00       ; n
  RES
  LOC 01       ; accumulator

  CONST 1
  SET 01
  BLOCK
    LOOP
      GET 00
      EQZ
      BRIF 1

      GET 01
      GET 00
      MUL
      SET 01

      GET 00
      CONST 1
      SUB
      SET 00
      BR 0
    END
  END
  GET 01
  RET
END
`},
  {id:'calls',name:'03 / Into the call stack',label:'Recursive Fibonacci. Try Step into.',entry:0,args:['7'],source:`; Fibonacci: fib(n-1) + fib(n-2).
; IF I32 produces a value on either path.

EXP "fibonacci" 00

FN 00
  PAR 00
  RES

  GET 00
  CONST 2
  LTS
  IF I32
    GET 00
  ELSE
    GET 00
    CONST 1
    SUB
    CALL 00

    GET 00
    CONST 2
    SUB
    CALL 00
    ADD
  END
  RET
END
`},
  {id:'memory',name:'04 / Leave a mark',label:'Store, load, and rewind linear memory.',entry:0,args:['42'],source:`; One WASM page = 65,536 bytes.
; STORE pops the value, then the address.

MEM 1 4
DATA 16 "HELLO, HEXAW!"
EXP "write" 00

FN 00
  PAR 00
  RES

  CONST 0      ; memory address
  GET 00       ; value to write
  STORE        ; i32, little-endian

  CONST 0
  LOAD
  RET
END
`},
  {id:'types',name:'05 / Beyond 32 bits',label:'Exact i64 arithmetic and floating point.',entry:0,args:['9007199254740993','2'],source:`; L = i64. F = f32. D = f64.
; i64 values stay exact using BigInt.

EXP "long_add" 00
EXP "circle_area" 01

FN 00
  LPAR 00
  LPAR 01
  LRES
  GET 00
  GET 01
  LADD
  RET
END

FN 01
  DPAR 00
  DRES
  GET 00
  GET 00
  DMUL
  DCONST 3.141592653589793
  DMUL
  RET
END
`},
  {id:'trap',name:'06 / A useful failure',label:'A real WASM trap you can rewind.',entry:0,args:['0'],source:`; Division by zero traps in WebAssembly.
; Step back to inspect the operands.

EXP "divide" 00

FN 00
  PAR 00
  RES
  CONST 100
  GET 00
  DIVS
  RET
END
`}
];
