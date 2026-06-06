// The v2 prompt graduated to production. Re-export it so the eval harness can
// still target it by name (`--prompt v2`) and its structure stays under test.
export { GATE_PROMPT as GATE_V2 } from "../../llm/prompts/gate.js";
