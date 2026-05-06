import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactElement } from 'react'

interface PaginationContextValue {
  currentIndex: number
  count: number
  goNext: () => void
  goPrev: () => void
}

const PaginationContext = createContext<PaginationContextValue | null>(null)

/** Consumed by RequestItemShell to render pagination controls in headerRight. */
export function usePagination() {
  return useContext(PaginationContext)
}

interface PendingRequestStackProps {
  children: ReactElement[]
}

const REVEAL_DURATION = 350

export function PendingRequestStack({ children }: PendingRequestStackProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const count = children.length

  // Track previous children to detect removals and trigger reveal animation
  const prevKeysRef = useRef<string[]>([])
  const [revealing, setRevealing] = useState(false)

  // Detect child removal → trigger reveal animation
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const currentKeys = children.map((c) => String(c.key))
    const prevKeys = prevKeysRef.current

    if (prevKeys.length > 0 && prevKeys.length > currentKeys.length) {
      setRevealing(true)
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current)
      revealTimerRef.current = setTimeout(() => {
        setRevealing(false)
        revealTimerRef.current = null
      }, REVEAL_DURATION)
    }

    prevKeysRef.current = currentKeys
  }, [children])

  // Clamp index when items are removed
  useEffect(() => {
    if (count > 0 && currentIndex >= count) {
      setCurrentIndex(count - 1)
    }
  }, [count, currentIndex])

  const goNext = useCallback(() => {
    setCurrentIndex((i) => Math.min(count - 1, i + 1))
  }, [count])

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1))
  }, [])

  if (count === 0) return null

  const idx = Math.min(currentIndex, count - 1)

  return (
    <PaginationContext.Provider value={{ currentIndex: idx, count, goNext, goPrev }}>
      {/* The container sizes to the ACTIVE card (+ its peeks) only. Inactive
          cards are absolutely positioned so they stay mounted — preserving
          their internal form state — but don't contribute to the container's
          height. Each card carries its own peek cards above, so peeks track
          the card's top edge as you paginate. The chat layout anchors this
          stack to the bottom of the chat column, so action rows stay put
          across pagination even though the container resizes. */}
      <div className="relative">
        {children.map((child, i) => {
          const peekDepth = Math.min(count - i - 1, 3)
          const isActive = i === idx
          return (
            <div
              key={child.key ?? i}
              style={{
                ...(isActive
                  ? {}
                  : { position: 'absolute', top: 0, left: 0, right: 0 }),
                visibility: isActive ? 'visible' : 'hidden',
                ...(isActive && revealing
                  ? { animation: `stack-reveal ${REVEAL_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1) forwards` }
                  : {}),
              }}
            >
              {Array.from({ length: peekDepth }, (_, j) => {
                const depth = peekDepth - j
                return (
                  <div
                    key={`peek-${depth}`}
                    className="rounded-t-[12px] border-x border-t bg-muted/20"
                    style={{
                      height: 10,
                      opacity: Math.max(0.3, 1 - depth * 0.25),
                      marginLeft: depth * 8,
                      marginRight: depth * 8,
                    }}
                  />
                )
              })}
              {child}
            </div>
          )
        })}

        <style>{`
          @keyframes stack-reveal {
            0% {
              opacity: 0;
              transform: translateY(8px) scale(0.98);
            }
            100% {
              opacity: 1;
              transform: translateY(0) scale(1);
            }
          }
        `}</style>
      </div>
    </PaginationContext.Provider>
  )
}
