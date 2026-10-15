import { useNavigate } from 'react-router-dom'
import { Folders, LogOut, User as UserIcon } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import DrillMenu from './DrillMenu'

/** Who you are, your drills, and sign out — one labelled menu. `rail` is the version pinned to the bottom of the side
 *  navigation: an initial and your first name, styled like the rail's own buttons. */
export default function AccountMenu({ variant = 'header' }: { variant?: 'header' | 'rail' }) {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  if (!user) return null
  const first = user.display_name.split(' ')[0]
  const items = [
    { id: 'drills', label: 'My drills', icon: <Folders size={18} />, onSelect: () => navigate('/drills') },
    { id: 'out', label: 'Sign out', icon: <LogOut size={18} />, onSelect: () => void signOut().then(() => navigate('/login')) },
  ]
  const header = <><b className="block text-base text-ink">{user.display_name}</b><span className="block break-all">{user.email}</span>{user.is_guest && <span className="mt-1 block font-semibold text-warn">Temporary demo account</span>}</>
  if (variant === 'rail') {
    return (
      <DrillMenu
        label={first}
        icon={<span className="flex h-9 w-9 items-center justify-center rounded-full border border-accent/50 bg-accent/10 text-base font-bold text-accent" aria-hidden>{first.slice(0, 1).toUpperCase()}</span>}
        menuLabel="Account menu"
        placement="rail"
        triggerTitle={`${user.display_name} — ${user.email}`}
        triggerClassName="flex h-[76px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-transparent px-1 text-xs font-semibold text-ink-2 transition-colors hover:bg-hi hover:text-ink aria-expanded:border-accent/50 aria-expanded:text-ink"
        header={header}
        items={items}
      />
    )
  }
  return <DrillMenu label={first} icon={<UserIcon size={18} aria-hidden />} menuLabel="Account menu" header={header} items={items} />
}
