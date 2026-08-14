import { BrowserRouter, Routes, Route } from 'react-router-dom'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import AiChat from './components/AiChat'
import WarningModalHost from './components/WarningModal'
import CoolingFlowHost from './components/CoolingFlow'
import ReviewPanelHost from './components/ReviewPanel'
import Home from './pages/Home'
import Ledger from './pages/Ledger'
import Report from './pages/Report'
import Wishlist from './pages/Wishlist'
import Debt from './pages/Debt'
import NetWorth from './pages/NetWorth'
import Settings from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <TopBar />
      <Sidebar />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/report" element={<Report />} />
          <Route path="/wishlist" element={<Wishlist />} />
          <Route path="/debt" element={<Debt />} />
          <Route path="/networth" element={<NetWorth />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <AiChat />
      <WarningModalHost />
      <CoolingFlowHost />
      <ReviewPanelHost />
    </BrowserRouter>
  )
}
