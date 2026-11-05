import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import "./styles.css";
import { RunsPage } from "./pages/RunsPage";
import { RunPage } from "./pages/RunPage";
import { RulesPage } from "./pages/RulesPage";
import { MetaBar } from "./components/MetaBar";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <div className="shell">
        <div className="topbar">
          <Link to="/"><h1>Agent Develop & Review</h1></Link>
          <div className="row small">
            <Link to="/">Tasks</Link>
            <Link to="/rules">Rule sets</Link>
            <MetaBar />
          </div>
        </div>
        <Routes>
          <Route path="/" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/rules" element={<RulesPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  </React.StrictMode>,
);
