// Copyright 2026 the AAI authors. MIT license.
/**
 * Phone trees to test the caller against — each a task and the automated menu
 * that answers it, declared as data so two harnesses play the same one:
 *
 * - `agent.eval.test.ts` walks it with `walkPhoneTree` — the model's choices,
 *   one text turn per menu, no phone involved.
 * - `scripts/phone-tree-call.mjs` (in the aai repo) serves it as a REAL
 *   Twilio menu and has the deployed agent dial it — the keys as tones on a
 *   phone line, decoded by the carrier.
 *
 * Nothing in the agent imports this; it is test data.
 */

import type { PhoneTree } from "@alexkroman1/aai-runtime/testing/vitest";

/** A task the caller is handed, the menu that answers when it dials, and the leaf it should reach. */
export type PhoneTreeCall = { task: string; tree: PhoneTree; goal: string };

const PHARMACIST = {
  name: "pharmacist",
  prompt: "Bayview pharmacy, this is Dana speaking. How can I help you?",
};

const PHARMACY_TASK =
  "Call Bayview Medical's pharmacy to check whether Jordan Lee's prescription is ready " +
  "for pickup. Jordan's date of birth is March 3rd, 1985. Ask what time the pharmacy " +
  "closes today.";

/**
 * Three menus deep, with an extension shortcut and a wrong turn at each level:
 * a language menu, the main menu, then the pharmacy's own.
 */
export const PHARMACY_CALL: PhoneTreeCall = {
  task: PHARMACY_TASK,
  goal: "pharmacist",
  tree: {
    name: "language",
    prompt: "Para español, oprima el dos. For English, press one.",
    options: {
      "2": {
        name: "spanish",
        prompt: "Gracias por llamar a Bayview Medical. ¿En qué le puedo ayudar?",
      },
      "1": {
        name: "main",
        prompt:
          "Thank you for calling Bayview Medical. If this is a medical emergency, hang up " +
          "and dial 911. For appointments, press 1. For billing, press 2. For the pharmacy, " +
          "press 3. If you know your party's extension, you may dial it at any time.",
        options: {
          "1": { name: "appointments", prompt: "Appointments, this is Sam. How can I help?" },
          "2": { name: "billing", prompt: "Billing department, this is Lee." },
          "3": {
            name: "pharmacy",
            prompt:
              "Pharmacy. To refill a prescription, press 1. To check on a prescription or " +
              "speak with a pharmacist, press 2.",
            options: {
              "1": {
                name: "refill line",
                prompt: "Automated refills. Please enter your prescription number.",
              },
              "2": PHARMACIST,
              "204": PHARMACIST,
            },
          },
          "204": PHARMACIST,
        },
      },
    },
  },
};

/** One menu where no option names the task — the caller should take the catch-all. */
export const NO_FIT_CALL: PhoneTreeCall = {
  task: PHARMACY_TASK,
  goal: "operator",
  tree: {
    name: "main",
    prompt:
      "Thank you for calling Bayview Medical. For lab results, press 1. For new patient " +
      "registration, press 2. For all other questions, press 0.",
    options: {
      "1": { name: "lab results", prompt: "Lab results line. Please enter your patient ID." },
      "2": { name: "registration", prompt: "New patient registration, this is Kim." },
      "0": { name: "operator", prompt: "Bayview Medical operator, how may I direct your call?" },
    },
  },
};
