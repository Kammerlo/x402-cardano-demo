import { ACTORS, type Actor } from "../lib/actors";
import { ActorRail, type RailPhase } from "./ActorRail";

interface HeroProps {
  railPhase: RailPhase;
  errorActor?: Actor;
}

/**
 * What a screenshot of this page captures before anyone connects a wallet.
 * Has to stand on its own: the thesis (what x402 is), the cast (the three
 * actors + the chain they settle on), and the invitation to connect.
 */
export function Hero({ railPhase, errorActor }: HeroProps) {
  return (
    <header className="hero">
      <div className="hero__intro">
        <p className="eyebrow">x402 protocol demo · live on cardano preprod</p>
        <h1 className="hero__headline">
          402 isn&rsquo;t an error.
          <br />
          It&rsquo;s an invoice.
        </h1>
        <p className="hero__subhead">
          <strong>x402</strong> turns HTTP&rsquo;s oldest unused status code into a machine-to-machine payment rail. A
          client asks for a resource, the server names its price, a wallet pays exactly that price on-chain, and the
          resource unlocks — no accounts, no API keys, nothing to reconcile afterward.
        </p>
        <p className="hero__note">
          Every ADA on this page is testnet ADA on <strong>Cardano preprod</strong> — worth nothing, spent freely.
          Need some in your wallet?{" "}
          <a href="https://docs.cardano.org/cardano-testnets/tools/faucet/" target="_blank" rel="noreferrer">
            Preprod faucet ↗
          </a>
        </p>
      </div>

      <ActorRail phase={railPhase} errorActor={errorActor} />

      <ul className="actor-legend">
        {ACTORS.map((actor) => (
          <li key={actor.id} className="actor-legend__item">
            <span className="actor-legend__label">{actor.label}</span>
            <span className="actor-legend__role">{actor.role}</span>
            <span className="actor-legend__blurb">{actor.blurb}</span>
          </li>
        ))}
      </ul>
    </header>
  );
}
