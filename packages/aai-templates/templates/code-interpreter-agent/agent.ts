import { agent } from "@alexkroman1/aai";

export default agent({
  name: "Coda",
  greeting:
    "Hey, I'm Coda. I solve problems by writing and running code. Try asking me something like, what's the 50th fibonacci number, or what day of the week was January 1st 2000.",
  builtinTools: ["run_code"],
});
