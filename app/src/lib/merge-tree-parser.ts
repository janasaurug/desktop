import { IMergeEntry, MergeResult, MergeResultKind } from '../models/merge'

interface IBlobSource {
  readonly type: string
  readonly path: string
  readonly sha: string
  readonly mode: string
}

function updateCurrentMergeEntry(
  entry: IMergeEntry | undefined,
  context: string,
  blobSource: IBlobSource
): IMergeEntry {
  const currentMergeEntry = entry || {
    context,
    diff: '',
  }

  const blob = {
    sha: blobSource.sha,
    mode: blobSource.mode,
    path: blobSource.path,
  }

  switch (blobSource.type) {
    case 'base':
      return {
        ...currentMergeEntry,
        base: blob,
      }
    case 'result':
      return {
        ...currentMergeEntry,
        result: blob,
      }
    case 'our':
      return {
        ...currentMergeEntry,
        our: blob,
      }
    case 'their':
      return {
        ...currentMergeEntry,
        their: blob,
      }
    default:
      return currentMergeEntry
  }
}

// the merge-tree output is a collection of entries like this
//
// changed in both
//  base   100644 f69fbc5c40409a1db7a3f8353bfffe46a21d6054 atom/browser/resources/mac/Info.plist
//  our    100644 9094f0f7335edf833d51f688851e6a105de60433 atom/browser/resources/mac/Info.plist
//  their  100644 2dd8bc646cff3869557549a39477e30022e6cfdd atom/browser/resources/mac/Info.plist
// @@ -17,9 +17,15 @@
// <key>CFBundleIconFile</key>
// <string>electron.icns</string>
// <key>CFBundleVersion</key>
// +<<<<<<< .our
// <string>4.0.0</string>
// <key>CFBundleShortVersionString</key>
// <string>4.0.0</string>
// +=======
// +  <string>1.4.16</string>
// +  <key>CFBundleShortVersionString</key>
// +  <string>1.4.16</string>
// +>>>>>>> .their
// <key>LSApplicationCategoryType</key>
//<string>public.app-category.developer-tools</string>
// <key>LSMinimumSystemVersion</key>

// The first line for each entry is what I'm referring to as the the header
// This regex filters on the known entries that can appear
const contextHeaderRe = /^(merged|added in remote|removed in remote|changed in both|removed in local|added in both)$/

// the rest of the header is made up of a number of entries formatted like this
//
//  base   100644 f69fbc5c40409a1db7a3f8353bfffe46a21d6054 atom/browser/resources/mac/Info.plist
//
// this regex let's us extract the blob details - the filename may also change
// as part of the merge if files are moved or renamed
const blobEntryRe = /^\s{2}(result|our|their|base)\s+(\d{6})\s([0-9a-f]{40})\s(.+)$/

/**
 * Parse the Git output of a merge-tree command to identify whether it
 * has detected any conflicts between the branches to be merged
 *
 * @param text the stdout from a `git merge-tree` command
 *
 */
export function parseMergeResult(text: string): MergeResult {
  const entries = new Array<IMergeEntry>()

  const lines = text.split('\n')

  let mergeEntryHeader: string | undefined
  let currentMergeEntry: IMergeEntry | undefined

  for (const line of lines) {
    const headerMatch = contextHeaderRe.exec(line)
    if (headerMatch != null) {
      mergeEntryHeader = headerMatch[1]

      // push the previous entry, if defined, into the array
      if (currentMergeEntry != null) {
        entries.push(currentMergeEntry)
        currentMergeEntry = undefined
      }

      continue
    }

    // the next lines are a number of merge result entries
    // pointing to blobs representing the source blob
    // and the resulting blob generated by the merge
    const blobMatch = blobEntryRe.exec(line)
    if (blobMatch != null) {
      const type = blobMatch[1]
      const mode = blobMatch[2]
      const sha = blobMatch[3]
      const path = blobMatch[4]

      const blob = {
        type,
        mode,
        sha,
        path,
      }

      if (mergeEntryHeader == null) {
        log.warn(
          `An unknown header was set while trying to parse the blob ${line}`
        )
        continue
      }

      switch (type) {
        case 'base':
        case 'result':
        case 'our':
        case 'their':
          currentMergeEntry = updateCurrentMergeEntry(
            currentMergeEntry,
            mergeEntryHeader,
            blob
          )
          break

        default:
          throw new Error(
            `invalid state - unexpected entry ${type} found when parsing rows`
          )
      }
      continue
    }

    if (currentMergeEntry == null) {
      throw new Error(
        `invalid state - trying to append the diff to a merge entry that isn't defined. line: '${line}'`
      )
    } else {
      const currentDiff = currentMergeEntry.diff
      const newDiff = currentDiff + line + '\n'
      currentMergeEntry = {
        ...currentMergeEntry,
        diff: newDiff,
      }

      const lineHasConflictMarker =
        line.startsWith('+<<<<<<<') ||
        line.startsWith('+=======') ||
        line.startsWith('+>>>>>>>')

      if (lineHasConflictMarker) {
        currentMergeEntry = {
          ...currentMergeEntry,
          hasConflicts: true,
        }
      }
    }
  }

  // ensure the last entry is pushed onto the array
  if (currentMergeEntry != null) {
    entries.push(currentMergeEntry)
    currentMergeEntry = undefined
  }

  const entriesWithConflicts = entries.filter(e => e.hasConflicts || false)

  if (entriesWithConflicts.length > 0) {
    return {
      kind: MergeResultKind.Conflicts,
      conflictedFiles: entriesWithConflicts.length,
    }
  } else {
    return { kind: MergeResultKind.Success, entries }
  }
}
