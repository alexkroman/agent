// Copyright 2026 the AAI authors. MIT license.
/**
 * The client half of `POST /workflows/uploads`.
 *
 * Its own module rather than another method body inside
 * `workflow-api-client.ts`, because it is the one call on that surface that is
 * not JSON in and JSON out: the body is a file, the metadata rides in the query
 * and the header, and the deadline rules are different (a 200 MB recording
 * legitimately takes minutes, where every other route is a round trip).
 *
 * Why an upload exists at all is in `sdk/step-uploads.ts`: a run's input is
 * journaled and replayed, so bytes may not travel in it.
 */

/** What an upload call accepts as the file's bytes. */
export type UploadBody = Blob | ArrayBuffer | ArrayBufferView | string;

/** Options for an upload. */
export type UploadOptions = {
  /** Filename to store. Defaults to a `File`'s own `name`, else `""`. */
  name?: string | undefined;
  /** MIME type to store. Defaults to a `Blob`'s own `type`, else octet-stream. */
  type?: string | undefined;
  /**
   * Abort the upload. Its own option rather than the client's `timeoutMs`,
   * which is sized for a JSON round trip: a large file legitimately takes
   * minutes, and a deadline that cannot tell those apart cancels the one thing
   * on this surface that is expensive to redo.
   */
  signal?: AbortSignal | undefined;
};

/** A stored upload, as `WorkflowApi.upload` resolves it. */
export type UploadRef = {
  /** The handle a run input carries. */
  id: string;
  /** Filename as stored. */
  name: string;
  /** MIME type as stored. */
  type: string;
  /** Size in bytes. */
  size: number;
  /** Absolute URL the bytes can be read back from, `Range` included. */
  url: string;
};

/**
 * Store one file against an already-resolved API base.
 *
 * @param base - The API root (`…/workflows`), as the client resolved it.
 * @param headers - Auth headers, if the API is closed.
 * @param fail - How the caller turns a failed response into an error, so this
 *   module does not own a second error vocabulary.
 * @internal
 */
export async function uploadFile(
  base: string,
  headers: Record<string, string>,
  fail: (res: Response) => Promise<Error>,
  file: UploadBody,
  options?: UploadOptions,
): Promise<UploadRef> {
  // A `File` already knows both; anything else says so or gets the defaults.
  const described = file as { name?: unknown; type?: unknown };
  const name = options?.name ?? (typeof described.name === "string" ? described.name : "");
  const type =
    options?.type ??
    (typeof described.type === "string" && described.type
      ? described.type
      : "application/octet-stream");
  const res = await fetch(`${base}/uploads?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": type },
    // `NonNullable` because `exactOptionalPropertyTypes` reads the property's
    // own `| undefined` as a value this may be, and a body is exactly what an
    // upload always has.
    body: file as NonNullable<RequestInit["body"]>,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) throw await fail(res);
  const stored = (await res.json()) as { id: string; name: string; type: string; size: number };
  // The URL is built from THIS client's base, not from the `url` the agent
  // answered with: the agent knows its own paths and not the origin it was
  // reached on, which on the platform is `/:slug/workflows/…`.
  return { ...stored, url: `${base}/uploads/${encodeURIComponent(stored.id)}` };
}
