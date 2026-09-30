/** Skeletons match the exact proportions of the components they stand in for, so the
 *  layout does not move when live data arrives (CLS = 0). */

export function IncidentCardSkeleton() {
  return (
    <div className="h-[132px] rounded-lg border border-line bg-panel p-3" aria-hidden>
      <div className="flex items-center gap-2">
        <div className="skeleton h-6 w-44" />
        <div className="skeleton h-6 w-12" />
        <div className="skeleton ml-auto h-4 w-14" />
      </div>
      <div className="skeleton mt-3 h-5 w-3/4" />
      <div className="skeleton mt-2 h-4 w-full" />
      <div className="mt-3 flex gap-2">
        <div className="skeleton h-6 w-28" />
        <div className="skeleton h-6 w-24" />
      </div>
    </div>
  )
}

export function IncidentFeedSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2 p-2" role="status" aria-busy="true" aria-label="Loading incidents">
      {Array.from({ length: count }, (_, i) => <IncidentCardSkeleton key={i} />)}
    </div>
  )
}

export function RecommendationSkeleton() {
  return (
    <div className="space-y-3 p-3" role="status" aria-busy="true" aria-label="Loading command recommendations">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-lg border border-line p-3" aria-hidden>
          <div className="skeleton h-6 w-5/6" />
          <div className="skeleton mt-3 h-4 w-full" />
          <div className="skeleton mt-2 h-4 w-4/5" />
          <div className="mt-3 flex gap-2"><div className="skeleton h-6 w-32" /><div className="skeleton h-6 w-28" /></div>
        </div>
      ))}
    </div>
  )
}

export function FleetSkeleton() {
  return (
    <div className="space-y-1 p-2" role="status" aria-busy="true" aria-label="Loading units">
      {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-11 w-full" aria-hidden />)}
    </div>
  )
}

export function MapSkeleton() {
  return <div className="skeleton absolute inset-0 rounded-none" role="status" aria-busy="true" aria-label="Loading map" />
}
