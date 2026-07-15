import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ModelProvider } from './context/ModelContext';
import { PreferenceProvider } from './context/PreferenceContext';
import Sidebar from './components/Sidebar';
import Home from './pages/Home';
import ClusterDetail from './pages/ClusterDetail';
import ConfigPage from './pages/ConfigPage';
import EmbedCluster from './pages/EmbedCluster';
import EmbedMemoryGraph from './pages/EmbedMemoryGraph';

export default function App() {
  return (
    <BrowserRouter>
      <ModelProvider>
        <PreferenceProvider>
          <Routes>
            {}
            <Route path="/embed/cluster/:id" element={<EmbedCluster />} />
            <Route path="/embed/memory-graph" element={<EmbedMemoryGraph />} />

            {}
            <Route path="*" element={
            <>
                <Sidebar />
                <main className="main">
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/cluster/:id" element={<ClusterDetail />} />
                    <Route path="/config" element={<ConfigPage />} />
                  </Routes>
                </main>
              </>
            } />
          </Routes>
        </PreferenceProvider>
      </ModelProvider>
    </BrowserRouter>);

}
