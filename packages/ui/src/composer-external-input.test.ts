import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  observeExternalComposerInput,
  type ExternalComposerInputTarget,
} from "./composer-external-input.js";

type Listener = () => void;

class FakeTextarea implements ExternalComposerInputTarget {
  public value = "";
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: "input" | "change", listener: Listener): void {
    const bucket = this.listeners.get(type) ?? new Set<Listener>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: "input" | "change", listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(): number {
    let total = 0;
    for (const bucket of this.listeners.values()) total += bucket.size;
    return total;
  }

  /** Mimics an accessibility client running AXSetValue on the node. */
  setValueExternally(value: string): void {
    this.value = value;
    for (const type of ["input", "change"] as const) {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
    }
  }
}

describe("external composer input", () => {
  it("pushes an accessibility write back into the draft", () => {
    const node = new FakeTextarea();
    let draft = "";
    const received: string[] = [];
    observeExternalComposerInput(node, {
      readDraft: () => draft,
      onExternalInput: (value) => {
        received.push(value);
        draft = value;
      },
    });

    node.setValueExternally("停止继续加装饰几何体");

    assert.deepEqual(received, ["停止继续加装饰几何体"]);
    assert.equal(draft, "停止继续加装饰几何体");
  });

  it("stays silent when the DOM already matches the draft", () => {
    const node = new FakeTextarea();
    const received: string[] = [];
    observeExternalComposerInput(node, {
      readDraft: () => "same",
      onExternalInput: (value) => received.push(value),
    });

    node.setValueExternally("same");

    assert.deepEqual(received, [], "typing echoes must not re-enter React state");
  });

  it("reads the draft at event time so repeated writes are not stale", () => {
    const node = new FakeTextarea();
    let draft = "";
    const received: string[] = [];
    observeExternalComposerInput(node, {
      readDraft: () => draft,
      onExternalInput: (value) => {
        received.push(value);
        draft = value;
      },
    });

    node.setValueExternally("first");
    node.setValueExternally("first");
    node.setValueExternally("second");

    assert.deepEqual(received, ["first", "second"]);
  });

  it("clears the field when an external write empties it", () => {
    const node = new FakeTextarea();
    let draft = "queued text";
    node.value = "queued text";
    observeExternalComposerInput(node, {
      readDraft: () => draft,
      onExternalInput: (value) => {
        draft = value;
      },
    });

    node.setValueExternally("");

    assert.equal(draft, "");
  });

  it("detaches every listener on cleanup and tolerates a second call", () => {
    const node = new FakeTextarea();
    const received: string[] = [];
    const release = observeExternalComposerInput(node, {
      readDraft: () => "",
      onExternalInput: (value) => received.push(value),
    });

    assert.equal(node.listenerCount(), 2);
    release();
    release();
    assert.equal(node.listenerCount(), 0);

    node.setValueExternally("after release");
    assert.deepEqual(received, []);
  });

  it("returns a no-op release when the composer is not mounted", () => {
    const release = observeExternalComposerInput(null, {
      readDraft: () => "",
      onExternalInput: () => assert.fail("must not fire without a node"),
    });
    release();
  });
});
