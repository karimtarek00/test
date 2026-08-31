import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.jsx';
import { ProtectedLayout, AdminRoute } from './components/ProtectedRoute.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import AlarmsPage from './pages/AlarmsPage.jsx';
import AnalysisPage from './pages/AnalysisPage.jsx';
import InventoryPage from './pages/InventoryPage.jsx';
import CriticalDashboardPage from './pages/CriticalDashboardPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import ImportDataPage from './pages/ImportDataPage.jsx';
import ConfigurationPage from './pages/ConfigurationPage.jsx';
import UsersPage from './pages/UsersPage.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/alarms" element={<AlarmsPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/critical" element={<CriticalDashboardPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route element={<AdminRoute />}>
              <Route path="/import" element={<ImportDataPage />} />
              <Route path="/configuration" element={<ConfigurationPage />} />
              <Route path="/users" element={<UsersPage />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
