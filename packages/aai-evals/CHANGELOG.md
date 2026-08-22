# aai-evals

## 0.1.17

### Patch Changes

- d98169a: Hash the starter-eval corpus in this package's cached test tasks.
  `starter-expectations.test.ts` imports `EXPECTATIONS` and `checkCapabilities`
  from `../../scripts/starter-eval/expectations.mjs` and asserts directly over
  that data, but `inputs` globs resolve relative to the PACKAGE — so editing an
  expectation replayed a cached green `aai-evals#test:coverage`, the very task the
  CI coverage matrix added so these suites are gated at all. Verified the
  documented way: the task hash was byte-identical across a change to the corpus
  before this, and moves with it after.
  
  Scoped to a package `turbo.json` rather than the root `globalDependencies`,
  whose five entries are all files every task reads; this corpus is read by one.
- Updated dependencies [12ead27]
- Updated dependencies [028044a]
- Updated dependencies [43ceb43]
- Updated dependencies [8c9ce20]
- Updated dependencies [9b9051a]
- Updated dependencies [55d5ec1]
- Updated dependencies [d98169a]
- Updated dependencies [ea0c9c9]
- Updated dependencies [d1e7c56]
- Updated dependencies [a7309a5]
- Updated dependencies [43ceb43]
- Updated dependencies [df8effa]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
  - @alexkroman1/aai@7.0.0

## 0.1.16

### Patch Changes

- Updated dependencies [11e4892]
- Updated dependencies [91364b0]
- Updated dependencies [3d20929]
- Updated dependencies [0397945]
- Updated dependencies [12deeec]
- Updated dependencies [8958dd1]
- Updated dependencies [1602a0e]
- Updated dependencies [0da62af]
- Updated dependencies [70e3ceb]
- Updated dependencies [f433015]
- Updated dependencies [298f3f2]
- Updated dependencies [1602a0e]
  - @alexkroman1/aai@6.11.0

## 0.1.15

### Patch Changes

- Updated dependencies [5556ed5]
  - @alexkroman1/aai@6.10.1

## 0.1.14

### Patch Changes

- Updated dependencies [1a76804]
  - @alexkroman1/aai@6.10.0

## 0.1.13

### Patch Changes

- Updated dependencies [9d45c1e]
  - @alexkroman1/aai@6.9.1

## 0.1.12

### Patch Changes

- Updated dependencies [203c2d4]
- Updated dependencies [bbde9f9]
  - @alexkroman1/aai@6.9.0

## 0.1.11

### Patch Changes

- @alexkroman1/aai@6.8.0

## 0.1.10

### Patch Changes

- Updated dependencies [7f2637c]
  - @alexkroman1/aai@6.7.2

## 0.1.9

### Patch Changes

- Updated dependencies [c46dac6]
  - @alexkroman1/aai@6.7.1

## 0.1.8

### Patch Changes

- Updated dependencies [9882411]
  - @alexkroman1/aai@6.7.0

## 0.1.7

### Patch Changes

- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
  - @alexkroman1/aai@6.6.0

## 0.1.6

### Patch Changes

- 58788ee: Internal quality pass: give repeated shapes one home each, remove stranded code, and hoist redundant work out of render and streaming paths. No API or behaviour change.
- Updated dependencies [58788ee]
- Updated dependencies [e2c2cda]
- Updated dependencies [153264f]
  - @alexkroman1/aai@6.5.1

## 0.1.5

### Patch Changes

- Updated dependencies [4da4327]
- Updated dependencies [4da4327]
  - @alexkroman1/aai@6.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [5288539]
  - @alexkroman1/aai@6.4.0

## 0.1.3

### Patch Changes

- Updated dependencies [dd29277]
  - @alexkroman1/aai@6.3.1

## 0.1.2

### Patch Changes

- Updated dependencies [b04af38]
- Updated dependencies [2e103d8]
  - @alexkroman1/aai@6.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [295e8db]
  - @alexkroman1/aai@6.2.0
