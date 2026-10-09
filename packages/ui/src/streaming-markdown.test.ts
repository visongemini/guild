import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./App.js";
import { splitStreamingMarkdown, StreamingMarkdownSplitter } from "./streaming-markdown.js";

const corpus: Readonly<Record<string, string>> = {
  paragraphs: "First paragraph with **bold** and `code`.\n\nSecond paragraph.\n\n\n\nThird after many blank lines.\n",
  headings: "# Title\n\nIntro text.\n\n## Section\n\nBody under the section.\n\n### Detail\nImmediately followed text.\n",
  tightList: "Steps:\n\n- one\n- two\n- three\n\nDone.\n",
  looseList: "Plan:\n\n- first item\n\n- second item\n\n- third item\n\nAfter the list.\n",
  orderedLooseList: "1. alpha\n\n2. beta\n\n3. gamma\n\nTail.\n",
  listAfterHeadingThenLoose: "## Items\n- a\n- b\n\n- c\n\nEnd.\n",
  nestedList: "- parent\n  - child one\n  - child two\n\n    continued paragraph of child two\n- sibling\n\nOutside.\n",
  fence: "Before.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n\n\nconsole.log(a + b);\n```\n\nAfter the code.\n",
  tildeFence: "~~~\nline one\n\nline two\n~~~\n\nNext.\n",
  fenceInsideList: "- item\n\n  ```\n  code in item\n\n  more code\n  ```\n\n- next item\n",
  indentedCode: "Text.\n\n    indented code line\n\n    second code line\n\nText again.\n",
  blockquote: "> quoted line one\n>\n> quoted line two\n\nPlain.\n\n> another quote\n",
  table: "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter table.\n",
  thematicBreak: "Above.\n\n---\n\nBelow.\n\n***\n\nEnd.\n",
  setext: "Heading\n=======\n\nText\n\nSub\n---\n\nEnd.\n",
  chinese: "你好，这是第一段。\n\n第二段包含 **加粗** 和 `代码`。\n\n- 列表项一\n- 列表项二\n\n结尾。\n",
  links: "See [docs](https://example.com/docs) and https://example.com/raw.\n\nSecond [link](https://example.org).\n",
  mixed: "# Report\n\nSummary paragraph.\n\n| k | v |\n|---|---|\n| a | 1 |\n\n```\nlog\n\nlines\n```\n\n1. step\n2. step\n\n> note\n\nDone.\n",
  trailingBlank: "Paragraph one.\n\nParagraph two.\n\n\n",
  crlf: "One.\r\n\r\nTwo.\r\n\r\n- a\r\n- b\r\n",
};

const normalize = (html: string): string => html.replace(/>\s+</gu, "><").trim();
const render = (text: string): string => renderToStaticMarkup(renderMarkdown(text, () => undefined, "en-US"));
const renderBlocks = (blocks: readonly string[]): string => normalize(blocks.map(render).join(""));

for (const [name, document] of Object.entries(corpus)) {
  test(`finished and streaming renderings of "${name}" match a single parse`, () => {
    assert.equal(renderBlocks(splitStreamingMarkdown(document)), normalize(render(document)));
  });
}

test("every complete-line prefix of every document renders like one parse of that prefix", () => {
  for (const [name, document] of Object.entries(corpus)) {
    const splitter = new StreamingMarkdownSplitter();
    for (let cut = 0; cut <= document.length; cut += 1) {
      if (cut !== document.length && document[cut - 1] !== "\n") continue;
      const prefix = document.slice(0, cut);
      assert.equal(
        renderBlocks(splitter.update(prefix)),
        normalize(render(prefix)),
        `${name} cut at ${cut}: ${JSON.stringify(prefix.slice(-40))}`,
      );
    }
  }
});

test("incremental updates produce the same blocks as splitting from scratch, at every character", () => {
  for (const [name, document] of Object.entries(corpus)) {
    const splitter = new StreamingMarkdownSplitter();
    for (let cut = 0; cut <= document.length; cut += 1) {
      const prefix = document.slice(0, cut);
      assert.deepEqual(splitter.update(prefix), splitStreamingMarkdown(prefix), `${name} at ${cut}`);
    }
  }
});

test("blocks are append-only: earlier blocks never change while text grows", () => {
  const document = corpus["mixed"]!;
  const splitter = new StreamingMarkdownSplitter();
  let committed: readonly string[] = [];
  for (let cut = 0; cut <= document.length; cut += 1) {
    const blocks = splitter.update(document.slice(0, cut));
    const stable = blocks.slice(0, -1);
    assert.deepEqual(stable.slice(0, committed.length), committed.slice(0, stable.length));
    assert.ok(stable.length >= committed.length, "a committed block is never merged back");
    committed = stable;
  }
});

test("a message that is not a pure append restarts cleanly", () => {
  const splitter = new StreamingMarkdownSplitter();
  splitter.update("One.\n\nTwo.\n\nThree");
  assert.deepEqual(splitter.update("Fresh start"), ["Fresh start"]);
  assert.deepEqual(splitter.update("Fresh start\n\nSecond\n"), ["Fresh start\n", "Second\n"]);
});

test("splits only at blank lines outside fences when the next complete line starts at column 0", () => {
  assert.deepEqual(splitStreamingMarkdown("a\n\nb\n"), ["a\n", "b\n"]);
  assert.deepEqual(splitStreamingMarkdown("a\n\n\n\nb\n\nc\n"), ["a\n", "b\n", "c\n"]);
  assert.deepEqual(splitStreamingMarkdown("a\n\n  indented continuation\n"), ["a\n\n  indented continuation\n"]);
  assert.deepEqual(splitStreamingMarkdown("```\nx\n\ny\n```\n\nz\n"), ["```\nx\n\ny\n```\n", "z\n"]);
  assert.deepEqual(splitStreamingMarkdown("```\nx\n\ny\n"), ["```\nx\n\ny\n"], "an unclosed fence is one growing block");
  assert.deepEqual(splitStreamingMarkdown("- a\n\n- b\n\n- c\n"), ["- a\n\n- b\n\n- c\n"], "a loose list stays one block");
  assert.deepEqual(splitStreamingMarkdown("- a\n\ntext\n\n- b\n"), ["- a\n", "text\n", "- b\n"]);
  assert.deepEqual(splitStreamingMarkdown("only one line"), ["only one line"]);
  assert.deepEqual(splitStreamingMarkdown("a\n\nb"), ["a\n\nb"], "a partial last line never decides a boundary");
  assert.deepEqual(splitStreamingMarkdown(""), [""]);
});

test("constructs that depend on distant text disable splitting for the whole message", () => {
  for (const document of [
    "See [ref].\n\nMore text.\n\n[ref]: https://example.com\n",
    "Claim[^1] here.\n\nNext.\n\n[^1]: footnote\n",
    "Text.\n\n<!-- comment\n\nspans blank -->\n\nMore.\n",
    "Text.\n\n<pre>\n\nraw\n</pre>\n\nMore.\n",
  ]) {
    assert.deepEqual(splitStreamingMarkdown(document), [document]);
  }
  // A late definition retroactively merges everything seen so far.
  const splitter = new StreamingMarkdownSplitter();
  assert.deepEqual(splitter.update("One.\n\nTwo.\n\nThree\n"), ["One.\n", "Two.\n", "Three\n"]);
  assert.deepEqual(splitter.update("One.\n\nTwo.\n\nThree\n\n[a]: https://x.y\n"), ["One.\n\nTwo.\n\nThree\n\n[a]: https://x.y\n"]);
});

test("a long streamed answer keeps almost all blocks stable between updates", () => {
  const paragraphs = Array.from({ length: 200 }, (_, index) => `Paragraph ${index} with some words in it.`);
  const document = paragraphs.join("\n\n");
  const splitter = new StreamingMarkdownSplitter();
  let previous = splitter.update(document.slice(0, 5_000));
  const next = splitter.update(document.slice(0, 5_040));
  const sharedPrefix = previous.slice(0, -1).filter((block, index) => block === next[index]).length;
  assert.equal(sharedPrefix, previous.length - 1, "committed blocks keep identical text, so their markup is reused");
  previous = next;
  assert.ok(previous.length > 50);
});
