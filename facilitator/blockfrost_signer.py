"""Blockfrost-backed implementation of FacilitatorCardanoSigner for the demo.

Only the chain-read parts are exercised in `default` assetTransferMethod (the
sender pays fees and signs); we still expose `submit_transaction` so /settle
works and `evaluate_transaction` so verify() can perform a node-side
authorization dry-run via Blockfrost's `/utils/txs/evaluate`.
"""

from __future__ import annotations

import base64

import httpx

from x402.mechanisms.cardano import (
    CardanoSubmissionResult,
    CardanoUtxoSnapshot,
)

PREPROD_BASE = "https://cardano-preprod.blockfrost.io/api/v0"


class BlockfrostFacilitatorSigner:
    """Concrete `FacilitatorCardanoSignerWithEvaluate` for the demo.

    The signer is read-only on the funds side; it does not hold any private
    keys. All methods translate Cardano facilitator queries to Blockfrost
    REST calls.
    """

    def __init__(self, project_id: str, base_url: str = PREPROD_BASE) -> None:
        """Create the signer.

        Args:
            project_id: Blockfrost preprod project id.
            base_url: API base URL (override only for self-hosted deployments).
        """
        if not project_id:
            raise ValueError("BLOCKFROST_PROJECT_ID_PREPROD is required")
        self._project_id = project_id
        self._base = base_url.rstrip("/")
        self._client = httpx.Client(
            timeout=httpx.Timeout(30.0),
            headers={"project_id": project_id},
        )

    # ------------------------------------------------------------------ #
    # FacilitatorCardanoSigner protocol
    # ------------------------------------------------------------------ #

    def get_addresses(self) -> list[str]:
        """The default Cardano scheme has no fee-payer; return an empty list.

        Returns:
            Empty list (the sender funds and signs the transaction).
        """
        return []

    def get_utxo(self, ref: str, network: str) -> CardanoUtxoSnapshot:
        """Look up whether a UTXO `txhash#index` is currently unspent.

        Args:
            ref: UTXO reference.
            network: x402 Cardano network identifier (only `cardano:preprod`).

        Returns:
            Snapshot describing the UTXO presence.
        """
        _ = network
        tx_hash, index_str = ref.split("#", 1)
        index = int(index_str)

        # 1. Fetch the producing transaction's outputs to learn the address.
        tx_response = self._client.get(f"{self._base}/txs/{tx_hash}/utxos")
        if tx_response.status_code == 404:
            return CardanoUtxoSnapshot(exists=False)
        tx_response.raise_for_status()
        outputs = tx_response.json().get("outputs", [])
        if index >= len(outputs):
            return CardanoUtxoSnapshot(exists=False)
        address = outputs[index].get("address")
        if not address:
            return CardanoUtxoSnapshot(exists=False)

        # 2. Check the address's current UTXO set; presence proves "unspent".
        addr_response = self._client.get(
            f"{self._base}/addresses/{address}/utxos",
            params={"order": "desc", "count": 100},
        )
        if addr_response.status_code == 404:
            return CardanoUtxoSnapshot(exists=False, address=address)
        addr_response.raise_for_status()
        utxos = addr_response.json()
        for utxo in utxos:
            if utxo.get("tx_hash") == tx_hash and int(utxo.get("output_index", -1)) == index:
                return CardanoUtxoSnapshot(exists=True, address=address)
        return CardanoUtxoSnapshot(exists=False, address=address)

    def get_current_slot(self, network: str) -> int:
        """Return the current absolute slot number from `/blocks/latest`.

        Args:
            network: x402 Cardano network identifier (unused).

        Returns:
            The current absolute slot.
        """
        _ = network
        response = self._client.get(f"{self._base}/blocks/latest")
        response.raise_for_status()
        slot = response.json().get("slot")
        if slot is None:
            raise RuntimeError("Blockfrost /blocks/latest returned no slot")
        return int(slot)

    def submit_transaction(
        self, signed_transaction_base64: str, network: str
    ) -> CardanoSubmissionResult:
        """Submit a signed CBOR transaction via `/tx/submit`.

        Args:
            signed_transaction_base64: Base64-encoded CBOR signed transaction.
            network: x402 Cardano network identifier (unused).

        Returns:
            Submission result with the resulting tx hash.
        """
        _ = network
        tx_bytes = base64.b64decode(signed_transaction_base64)
        response = self._client.post(
            f"{self._base}/tx/submit",
            content=tx_bytes,
            headers={"Content-Type": "application/cbor"},
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Blockfrost /tx/submit rejected the transaction "
                f"(status={response.status_code}): {response.text}"
            )
        tx_hash = response.json() if response.text else ""
        if isinstance(tx_hash, str) and tx_hash.startswith('"') and tx_hash.endswith('"'):
            tx_hash = tx_hash.strip('"')
        # Blockfrost returns the tx hash on accept; mempool inclusion is
        # implicit. We surface "mempool" so the facilitator's acceptMempool
        # gate can decide whether to call it settled.
        return CardanoSubmissionResult(tx_hash=str(tx_hash), status="mempool")

    # ------------------------------------------------------------------ #
    # Optional capability: FacilitatorCardanoSignerWithEvaluate
    # ------------------------------------------------------------------ #

    def evaluate_transaction(
        self, signed_transaction_base64: str, network: str
    ) -> None:
        """Best-effort dry-run via Blockfrost `/utils/txs/evaluate`.

        Blockfrost only evaluates Plutus scripts; for plain transfer
        transactions the call still serves as a structural+ledger sanity
        check. Errors propagate so verify() can surface them.

        Args:
            signed_transaction_base64: Base64-encoded CBOR transaction.
            network: x402 Cardano network identifier (unused).
        """
        _ = network
        tx_bytes = base64.b64decode(signed_transaction_base64)
        response = self._client.post(
            f"{self._base}/utils/txs/evaluate",
            content=tx_bytes,
            headers={"Content-Type": "application/cbor"},
        )
        if response.status_code >= 400:
            # Blockfrost returns 400 for invalid txs and 403 when the project
            # plan doesn't have evaluate access; treat 403 as best-effort
            # success rather than a hard reject.
            if response.status_code == 403:
                return
            raise RuntimeError(
                f"Blockfrost /utils/txs/evaluate rejected the transaction "
                f"(status={response.status_code}): {response.text}"
            )
