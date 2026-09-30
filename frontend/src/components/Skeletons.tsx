export function SkeletonCard({ height = 84 }: { height?: number }) {
  return <div className="skeleton skeleton-card" style={{ height }} aria-hidden />
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading incidents">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

export function SkeletonRow() {
  return <div className="skeleton" style={{ height: 40, marginBottom: 8 }} aria-hidden />
}
