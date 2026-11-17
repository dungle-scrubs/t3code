import type { CSSProperties } from "react";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import "../../index.css";

import { MarkdownTable } from "./MarkdownTable";

const LANE = 400;
const WIDE_CELL = "a cell whose text is long enough to need room";

function lane(room: number, cells: readonly string[]) {
  return (
    <div style={{ width: 1000 }}>
      <div
        data-testid="lane"
        className="chat-markdown chat-markdown-breakout"
        style={
          { width: LANE, marginInline: "auto", "--chat-rich-room": `${room}px` } as CSSProperties
        }
      >
        <MarkdownTable>
          <tbody>
            <tr>
              {cells.map((cell, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- fixed cells
                <td key={index}>{cell}</td>
              ))}
            </tr>
          </tbody>
        </MarkdownTable>
        <div data-testid="frame" className="chat-rich-breakout" />
      </div>
    </div>
  );
}

it("widens a table past the lane only as far as its columns and the free room need", async () => {
  const wide = [WIDE_CELL, WIDE_CELL, WIDE_CELL, WIDE_CELL];
  await using screen = await render(lane(150, wide));
  const box = (element: Element) => element.getBoundingClientRect();
  const laneBox = () => box(screen.getByTestId("lane").element());
  const tableBox = () => box(screen.container.querySelector(".chat-markdown-table-frame")!);

  expect(tableBox().width).toBe(LANE + 300);
  expect(tableBox().left).toBe(laneBox().left - 150);
  expect(box(screen.getByTestId("frame").element()).left).toBe(laneBox().left - 150);
  expect(box(screen.getByTestId("frame").element()).width).toBe(LANE + 300);

  await screen.rerender(lane(150, ["one", "two"]));
  expect(tableBox().width).toBe(LANE);
  expect(tableBox().left).toBe(laneBox().left);

  await screen.rerender(lane(0, wide));
  expect(tableBox().width).toBe(LANE);
  expect(tableBox().left).toBe(laneBox().left);
});
