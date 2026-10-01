// Copyright 2025 the AAI authors. MIT license.

import type { Image } from "modal";

/** {@link fakeModalImage}'s double, with what it recorded. */
export type FakeModalImage = Image & {
  /** Every `dockerfileCommands` layer stacked on it, in order. */
  commands: string[][];
  /** How many times `build()` was called. */
  builds: number;
  /** Every tag `publish()` was called with, in order. */
  published: string[];
};

/**
 * A Modal `Image` double that records every layer's commands, its builds and
 * its publishes. `build()` resolves to the same double, so layers stacked on a
 * built image land in the one `commands` list.
 *
 * Holds the one cast for this shape: `Image` is a class with private fields,
 * so no structural stand-in satisfies it.
 */
export function fakeModalImage(): FakeModalImage {
  const image = {
    commands: [] as string[][],
    builds: 0,
    published: [] as string[],
    dockerfileCommands(next: string[]) {
      image.commands.push(next);
      return image;
    },
    build() {
      image.builds += 1;
      return Promise.resolve(image);
    },
    publish(tag: string) {
      image.published.push(tag);
      return Promise.resolve();
    },
  } as unknown as FakeModalImage;
  return image;
}
