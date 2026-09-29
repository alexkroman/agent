// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contract for `describeEval`'s case context: `ctx.network` is
 * typed by the `network` the suite (or the case) passed, state included.
 *
 * The runtime half — that the network a case is handed IS the one passed —
 * is `describe-network.test.ts`'s. What only the checker can see is the
 * friction this removed: a suite with a network still read
 * `EvalNetwork | undefined` and guarded every case with a throw, and a
 * route's shared state reached the case through a module-level `let`.
 */

import { agent } from "@alexkroman1/aai";
import { expectTypeOf, test } from "vitest";
import { describeEval } from "./describe.ts";
import { type EvalNetwork, evalNetwork } from "./network.ts";

type Row = { status: string };
const def = agent({ name: "Types" });

/** A network whose routes share a calls table. */
const withCalls = () =>
  evalNetwork({
    state: () => ({ calls: new Map<string, Row>() }),
    routes: {
      "crm.example": (_request, _info, state) => {
        expectTypeOf(state.calls).toEqualTypeOf<Map<string, Row>>();
        return [...state.calls.values()];
      },
    },
  });

test("a suite given a network FACTORY hands every case that network's type, state included", () => {
  describeEval(
    def,
    (it) => {
      it("reads the calls table", async ({ network }) => {
        expectTypeOf(network).not.toBeNullable();
        expectTypeOf(network).toExtend<EvalNetwork<{ calls: Map<string, Row> }>>();
        expectTypeOf(network.state).toEqualTypeOf<{ calls: Map<string, Row> }>();
      });
    },
    { network: withCalls },
  );
});

test("a suite given an INSTANCE hands that instance's type", () => {
  describeEval(
    def,
    (it) => {
      it("reads the log", async ({ network }) => {
        expectTypeOf(network).not.toBeNullable();
        expectTypeOf(network.state).toEqualTypeOf<undefined>();
      });
    },
    { network: evalNetwork() },
  );
});

test("with no network anywhere, the context says it may be absent", () => {
  describeEval(def, (it) => {
    it("has none", async ({ network }) => {
      expectTypeOf(network).toEqualTypeOf<EvalNetwork | undefined>();
    });
  });
});

test("a case's own network is of the suite's type, so the context's type holds for it", () => {
  describeEval(
    def,
    (it) => {
      it(
        "uses its own",
        async ({ network }) => {
          expectTypeOf(network.state.calls).toEqualTypeOf<Map<string, Row>>();
        },
        { network: withCalls },
      );
    },
    { network: withCalls },
  );
  describeEval(def, (it) => {
    it(
      "in a suite with none, a case's network is the untyped one",
      async ({ network }) => {
        expectTypeOf(network).toEqualTypeOf<EvalNetwork | undefined>();
      },
      { network: evalNetwork() },
    );
  });
});

test("a route cannot read state the network was not given", () => {
  evalNetwork({
    routes: {
      "crm.example": (_request, _info, state) => {
        expectTypeOf(state).toEqualTypeOf<undefined>();
      },
    },
  });
});
