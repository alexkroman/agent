import { agent, assemblyAIPipeline } from "@alexkroman1/aai";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import type { StateSlot } from "./shared.ts";
import { storeView } from "./shared.ts";
import { createDefaultState } from "./store.ts";
import systemPrompt from "./system-prompt.md?raw";
import { cancelPendingOrder } from "./tools/cancel_pending_order.ts";
import { exchangeDeliveredOrderItems } from "./tools/exchange_delivered_order_items.ts";
import { findUserIdByEmail } from "./tools/find_user_id_by_email.ts";
import { findUserIdByNameZip } from "./tools/find_user_id_by_name_zip.ts";
import { getItemDetails } from "./tools/get_item_details.ts";
import { getOrderDetails } from "./tools/get_order_details.ts";
import { getProductDetails } from "./tools/get_product_details.ts";
import { getUserDetails } from "./tools/get_user_details.ts";
import { listAllProductTypes } from "./tools/list_all_product_types.ts";
import { modifyPendingOrderAddress } from "./tools/modify_pending_order_address.ts";
import { modifyPendingOrderItems } from "./tools/modify_pending_order_items.ts";
import { modifyPendingOrderPayment } from "./tools/modify_pending_order_payment.ts";
import { modifyUserAddress } from "./tools/modify_user_address.ts";
import { returnDeliveredOrderItems } from "./tools/return_delivered_order_items.ts";
import { transferToHumanAgents } from "./tools/transfer_to_human_agents.ts";

export default agent({
  name: "Retail Support",
  ...assemblyAIPipeline(),

  // The store lives in ctx.state, one pristine copy per session — callers must
  // not see each other's cancellations. Wrapped in the `StateSlot` shape
  // `store.ts`'s `getState`/`shared.ts`'s `storeView` both key off — `agent()`
  // infers its session-state type parameter from BOTH `state` and `syncState`,
  // and `StateSlot`'s `retail` field is optional (a "weak type"), so handing
  // it a bare `RetailState` with no properties in common fails that inference
  // rather than an ordinary structural check.
  state: (): StateSlot => ({ retail: createDefaultState() }),

  // One projection pushed after every tool call. It is a projection, not a
  // flag, because the state holds all six seeded customers and only the
  // authenticated one may reach the browser.
  syncState: storeView,

  // Callers read order numbers and ten-digit item numbers in bursts with
  // pauses inside one utterance, so end-of-turn silence has to be longer than
  // the default or "W seven six seven … eight oh seven two" splits in two.
  stt: assemblyAIStt({ minTurnSilenceMs: 2200 }),

  systemPrompt,
  greeting:
    "Thanks for calling. Before I can look anything up I'll need to find your account — " +
    "what's the email address on it?",

  tools: {
    cancel_pending_order: cancelPendingOrder,
    exchange_delivered_order_items: exchangeDeliveredOrderItems,
    find_user_id_by_email: findUserIdByEmail,
    find_user_id_by_name_zip: findUserIdByNameZip,
    get_item_details: getItemDetails,
    get_order_details: getOrderDetails,
    get_product_details: getProductDetails,
    get_user_details: getUserDetails,
    list_all_product_types: listAllProductTypes,
    modify_pending_order_address: modifyPendingOrderAddress,
    modify_pending_order_items: modifyPendingOrderItems,
    modify_pending_order_payment: modifyPendingOrderPayment,
    modify_user_address: modifyUserAddress,
    return_delivered_order_items: returnDeliveredOrderItems,
    transfer_to_human_agents: transferToHumanAgents,
  },
});
