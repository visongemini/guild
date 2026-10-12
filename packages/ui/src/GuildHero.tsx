import type { GuildMessages } from "./locales.js";

/** The mascot, shown here and nowhere else (PC-UI-003). */
const BANNY_ASSET_URL = new URL("./assets/banny.png", import.meta.url).href;

/**
 * The hero of both empty states: the mascot, the G, U, I, L, D row and one helper line. The empty task and the
 * welcome screen (no task open) render this same component, so they look alike and the mascot has one place in the
 * source. It renders a fragment: the container supplies the centered column, and the screen adds its own actions
 * (the starter cards, or the new-task button) after it.
 */
export function GuildHero({ messages, help }: Readonly<{ messages: GuildMessages; help: string }>) {
  return <>
    <img className="guild-banny" src={BANNY_ASSET_URL} alt="" draggable={false} />
    <h1 className="guild-acronym" aria-label={messages.starterTitle}>{([
      ["G", "Goal", messages.guildGoal],
      ["U", "Understand", messages.guildUnderstand],
      ["I", "Implement", messages.guildImplement],
      ["L", "Loop", messages.guildLoop],
      ["D", "Deliver", messages.guildDeliver],
    ] as const).map(([letter, word, gloss]) => <span key={letter} aria-hidden="true"><b>{letter}</b><small>{word}</small>{gloss !== "" && <em>{gloss}</em>}</span>)}</h1>
    <p>{help}</p>
  </>;
}
