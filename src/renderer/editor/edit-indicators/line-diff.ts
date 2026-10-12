export type EditIndicatorState = 'none' | 'saved' | 'unsaved'

export interface EditIndicatorSnapshot {
  states: readonly EditIndicatorState[]
  openingLineCount: number
  savedLineCount: number
  currentLineCount: number
}

interface DiffOperation {
  type: 'equal' | 'insert' | 'delete'
  count: number
}

function visibleLines(markdown: string): string[] {
  return markdown.replace(/\r\n|\r/g, '\n').split('\n')
}

function pushOperation(operations: DiffOperation[], type: DiffOperation['type'], count = 1) {
  if (count === 0) return
  const previous = operations.at(-1)
  if (previous?.type === type) previous.count += count
  else operations.push({ type, count })
}

function findMyersBisect(
  before: readonly string[],
  beforeStart: number,
  beforeEnd: number,
  after: readonly string[],
  afterStart: number,
  afterEnd: number,
): readonly [number, number] | null {
  const beforeLength = beforeEnd - beforeStart
  const afterLength = afterEnd - afterStart
  const maxDistance = Math.ceil((beforeLength + afterLength) / 2)
  const offset = maxDistance + 1
  const vectorLength = (maxDistance * 2) + 3
  const forward = new Int32Array(vectorLength)
  const reverse = new Int32Array(vectorLength)
  forward.fill(-1)
  reverse.fill(-1)
  forward[offset + 1] = 0
  reverse[offset + 1] = 0
  const delta = beforeLength - afterLength
  const checkForwardOverlap = delta % 2 !== 0
  let forwardStart = 0
  let forwardEnd = 0
  let reverseStart = 0
  let reverseEnd = 0

  for (let distance = 0; distance <= maxDistance; distance += 1) {
    for (
      let diagonal = -distance + forwardStart;
      diagonal <= distance - forwardEnd;
      diagonal += 2
    ) {
      const vectorIndex = offset + diagonal
      let beforeIndex = diagonal === -distance || (
        diagonal !== distance
        && forward[vectorIndex - 1]! < forward[vectorIndex + 1]!
      )
        ? forward[vectorIndex + 1]!
        : forward[vectorIndex - 1]! + 1
      let afterIndex = beforeIndex - diagonal
      while (
        beforeIndex < beforeLength
        && afterIndex < afterLength
        && before[beforeStart + beforeIndex] === after[afterStart + afterIndex]
      ) {
        beforeIndex += 1
        afterIndex += 1
      }
      forward[vectorIndex] = beforeIndex
      if (beforeIndex > beforeLength) forwardEnd += 2
      else if (afterIndex > afterLength) forwardStart += 2
      else if (checkForwardOverlap) {
        const reverseIndex = offset + delta - diagonal
        if (
          reverseIndex >= 0
          && reverseIndex < vectorLength
          && reverse[reverseIndex]! !== -1
        ) {
          const reverseBeforeIndex = beforeLength - reverse[reverseIndex]!
          if (beforeIndex >= reverseBeforeIndex) {
            return [beforeStart + beforeIndex, afterStart + afterIndex]
          }
        }
      }
    }

    for (
      let diagonal = -distance + reverseStart;
      diagonal <= distance - reverseEnd;
      diagonal += 2
    ) {
      const vectorIndex = offset + diagonal
      let beforeIndex = diagonal === -distance || (
        diagonal !== distance
        && reverse[vectorIndex - 1]! < reverse[vectorIndex + 1]!
      )
        ? reverse[vectorIndex + 1]!
        : reverse[vectorIndex - 1]! + 1
      let afterIndex = beforeIndex - diagonal
      while (
        beforeIndex < beforeLength
        && afterIndex < afterLength
        && before[beforeEnd - beforeIndex - 1] === after[afterEnd - afterIndex - 1]
      ) {
        beforeIndex += 1
        afterIndex += 1
      }
      reverse[vectorIndex] = beforeIndex
      if (beforeIndex > beforeLength) reverseEnd += 2
      else if (afterIndex > afterLength) reverseStart += 2
      else if (!checkForwardOverlap) {
        const forwardIndex = offset + delta - diagonal
        if (
          forwardIndex >= 0
          && forwardIndex < vectorLength
          && forward[forwardIndex]! !== -1
        ) {
          const forwardBeforeIndex = forward[forwardIndex]!
          const forwardAfterIndex = forwardBeforeIndex - (delta - diagonal)
          const reverseBeforeIndex = beforeLength - beforeIndex
          if (forwardBeforeIndex >= reverseBeforeIndex) {
            return [
              beforeStart + forwardBeforeIndex,
              afterStart + forwardAfterIndex,
            ]
          }
        }
      }
    }
  }
  return null
}

function shortestEditScript(before: readonly string[], after: readonly string[]): DiffOperation[] {
  const operations: DiffOperation[] = []

  const visit = (
    originalBeforeStart: number,
    originalBeforeEnd: number,
    originalAfterStart: number,
    originalAfterEnd: number,
  ) => {
    let beforeStart = originalBeforeStart
    let afterStart = originalAfterStart
    while (
      beforeStart < originalBeforeEnd
      && afterStart < originalAfterEnd
      && before[beforeStart] === after[afterStart]
    ) {
      pushOperation(operations, 'equal')
      beforeStart += 1
      afterStart += 1
    }

    let beforeEnd = originalBeforeEnd
    let afterEnd = originalAfterEnd
    let commonSuffix = 0
    while (
      beforeEnd > beforeStart
      && afterEnd > afterStart
      && before[beforeEnd - 1] === after[afterEnd - 1]
    ) {
      beforeEnd -= 1
      afterEnd -= 1
      commonSuffix += 1
    }

    if (beforeStart === beforeEnd) {
      pushOperation(operations, 'insert', afterEnd - afterStart)
    } else if (afterStart === afterEnd) {
      pushOperation(operations, 'delete', beforeEnd - beforeStart)
    } else {
      const split = findMyersBisect(
        before,
        beforeStart,
        beforeEnd,
        after,
        afterStart,
        afterEnd,
      )
      if (
        !split
        || (split[0] === beforeStart && split[1] === afterStart)
        || (split[0] === beforeEnd && split[1] === afterEnd)
      ) {
        pushOperation(operations, 'delete', beforeEnd - beforeStart)
        pushOperation(operations, 'insert', afterEnd - afterStart)
      } else {
        visit(beforeStart, split[0], afterStart, split[1])
        visit(split[0], beforeEnd, split[1], afterEnd)
      }
    }
    pushOperation(operations, 'equal', commonSuffix)
  }

  visit(0, before.length, 0, after.length)
  return operations
}

interface LineAlignment {
  changedCurrent: boolean[]
  equalBeforeIndexByCurrent: Array<number | null>
}

function alignCurrentLines(before: readonly string[], current: readonly string[]): LineAlignment {
  const changed = Array(current.length).fill(false) as boolean[]
  const equalBeforeIndexByCurrent = Array(current.length).fill(null) as Array<number | null>
  let beforeIndex = 0
  let currentIndex = 0
  const operations = shortestEditScript(before, current)
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const operation = operations[operationIndex]!
    if (operation.type === 'equal') {
      for (let offset = 0; offset < operation.count; offset += 1) {
        equalBeforeIndexByCurrent[currentIndex + offset] = beforeIndex + offset
      }
      beforeIndex += operation.count
      currentIndex += operation.count
      continue
    }
    if (operation.type === 'insert') {
      changed.fill(true, currentIndex, currentIndex + operation.count)
      currentIndex += operation.count
      continue
    }
    const isReplacement = operations[operationIndex - 1]?.type === 'insert'
      || operations[operationIndex + 1]?.type === 'insert'
    if (!isReplacement) {
      const boundary = currentIndex < current.length ? currentIndex : currentIndex - 1
      if (boundary >= 0) changed[boundary] = true
    }
    beforeIndex += operation.count
  }
  return { changedCurrent: changed, equalBeforeIndexByCurrent }
}

export function computeLineEditIndicators(input: {
  openingMarkdown: string
  savedMarkdown: string
  currentMarkdown: string
}): EditIndicatorSnapshot {
  const openingLines = visibleLines(input.openingMarkdown)
  const savedLines = visibleLines(input.savedMarkdown)
  const currentLines = visibleLines(input.currentMarkdown)
  const snapshot = {
    openingLineCount: openingLines.length,
    savedLineCount: savedLines.length,
    currentLineCount: currentLines.length,
  }

  if (openingLines.length === currentLines.length && openingLines.every((line, index) => (
    line === currentLines[index]
  ))) {
    return { ...snapshot, states: currentLines.map(() => 'none' as const) }
  }

  const openingToSaved = alignCurrentLines(openingLines, savedLines)
  const savedToCurrent = alignCurrentLines(savedLines, currentLines)
  return {
    ...snapshot,
    states: currentLines.map((_, index): EditIndicatorState => {
      if (savedToCurrent.changedCurrent[index]) return 'unsaved'
      const savedIndex = savedToCurrent.equalBeforeIndexByCurrent[index]
      return savedIndex !== null && openingToSaved.changedCurrent[savedIndex]
        ? 'saved'
        : 'none'
    }),
  }
}
