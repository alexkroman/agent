/** @jsxImportSource react */
// @ts-expect-error CSS import handled by Vite
// At the PACKAGE root, not in `src/`: it is a published export
// (`@alexkroman1/aai-ui/styles.css`) and a Vite asset, so it sits beside
// `index.html` and `public/` where the exports map and `files` name it.
import "../styles.css";
import { client } from "./define-client.tsx";

client({});
