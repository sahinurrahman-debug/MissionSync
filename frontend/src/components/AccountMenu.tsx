import { useNavigate } from 'react-router-dom'
import { Folders, LogOut, User as UserIcon } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import DrillMenu from './DrillMenu'

/** Who you are, your drills, and sign out — one labelled menu. */
export default function AccountMenu() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  if (!user) return null
  const first = user.display_name.split(' ')[0]
  return (
    <DrillMenu
      label={first}
      icon={<UserIcon size={18} aria-hidden />}
      menuLabel="Account menu"
      header={<><b className="block text-base text-ink">{user.display_name}</b><span className="block break-all">{user.email}</span></>}
      items={[
        { id: 'drills', label: 'My drills', icon: <Folders size={18} />, onSelect: () => navigate('/drills') },
        { id: 'out', label: 'Sign out', icon: <LogOut size={18} />, onSelect: () => void signOut().then(() => navigate('/login')) },
      ]}
    />
  )
}
