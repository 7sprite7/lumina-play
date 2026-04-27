import { useEffect } from "react";
import { useAppStore } from "./store";
import TopBar from "./components/TopBar";
import Home from "./components/Home";
import Browser from "./components/Browser";
import SeriesDetail from "./components/SeriesDetail";
import MovieDetail from "./components/MovieDetail";
import SourceManager from "./components/SourceManager";
import Preferences from "./components/Preferences";
import WelcomePinDialog from "./components/WelcomePinDialog";
import Player from "./components/Player";
import { useT } from "./lib/i18n";

export default function App() {
  const init = useAppStore((s) => s.init);
  const view = useAppStore((s) => s.view);
  const playback = useAppStore((s) => s.playback);
  const sources = useAppStore((s) => s.sources);
  const setView = useAppStore((s) => s.setView);
  const theme = useAppStore((s) => s.settings.theme);
  const hasOnboarded = useAppStore((s) => s.settings.hasOnboarded);
  const adultPinHash = useAppStore((s) => s.settings.adultPinHash);
  const bootstrapped = useAppStore((s) => s.bootstrapped);
  const t = useT();

  useEffect(() => {
    init();
  }, [init]);

  // Only redirect to source manager AFTER init() has loaded persisted state.
  // Otherwise the initial empty `sources` array would push the user into the
  // SourceManager even when they have a saved active source on disk.
  useEffect(() => {
    if (bootstrapped && sources.length === 0 && view !== "settings") {
      setView("settings");
    }
  }, [bootstrapped, sources.length, view, setView]);

  // First-run PIN prompt: user has at least one source but hasn't been onboarded
  // and hasn't set a PIN yet.
  const showWelcomePin = sources.length > 0 && !hasOnboarded && adultPinHash === null;

  return (
    <div className={`flex flex-col h-full w-full bg-gradient theme-${theme}`}>
      <TopBar />

      <main className="flex-1 flex min-h-0 relative">
        {view === "home" && <Home />}
        {view === "live" && <Browser type="live" title={t("home.live")} />}
        {view === "movies" && <Browser type="movie" title={t("home.movies")} />}
        {view === "series" && <Browser type="series" title={t("home.series")} />}
        {view === "series-detail" && <SeriesDetail />}
        {view === "movie-detail" && <MovieDetail />}
        {view === "settings" && (
          <SourceManager onClose={sources.length > 0 ? () => setView("home") : undefined} />
        )}
        {view === "preferences" && <Preferences onClose={() => setView("home")} />}
      </main>

      {showWelcomePin && <WelcomePinDialog />}
      {playback && <Player />}
    </div>
  );
}
