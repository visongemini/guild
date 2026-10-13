import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { engineKeyConfirmationPrompt } from "./engine-key-messages.js";

const input = {
  engineName: "Gemini",
  host: "generativelanguage.googleapis.com",
  keyVariable: "GEMINI_API_KEY",
  keyFile: "/Users/me/.config/guild/keys.env",
} as const;

describe("engine key confirmation copy [PC-ENG-004]", () => {
  it("names the variable, the file and the host in both languages, and promises nothing about a key value", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const prompt = engineKeyConfirmationPrompt({ locale, ...input });
      for (const text of [prompt.message, prompt.detail]) {
        assert.ok(text.includes("generativelanguage.googleapis.com") || text === prompt.detail, locale);
      }
      assert.ok(prompt.message.includes("GEMINI_API_KEY") && prompt.message.includes("keys.env") && prompt.message.includes(input.host), locale);
      assert.ok(prompt.detail.includes(input.host) && prompt.detail.includes("Gemini"), locale);
      assert.notEqual(prompt.cancelLabel, prompt.allowLabel);
    }
    assert.equal(engineKeyConfirmationPrompt({ locale: "zh-CN", ...input }).allowLabel, "允许");
    assert.equal(engineKeyConfirmationPrompt({ locale: "en-US", ...input }).allowLabel, "Allow");
  });

  it("shortens a very long path in the middle", () => {
    const long = `/${"a".repeat(400)}/keys.env`;
    const prompt = engineKeyConfirmationPrompt({ locale: "en-US", ...input, keyFile: long });
    assert.ok(prompt.message.length < 400);
    assert.ok(prompt.message.includes("...") && prompt.message.includes("keys.env"));
  });
});
