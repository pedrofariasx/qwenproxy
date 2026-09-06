import chalk from "chalk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface BannerOptions {
  port: number;
  browser: string;
  accountCount: number;
}

export function renderBanner(opts: BannerOptions): string {
  const version = getVersion();
  const dashboardUrl = `http://localhost:${opts.port}/admin`;

  const logo = [
    chalk.white(" ██████╗ ██╗    ██╗███████╗███╗   ██╗") +
      chalk.hex("#663fe0")("██████╗ ██████╗  ██████╗ ██╗  ██╗██╗   ██╗"),
    chalk.white("██╔═══██╗██║    ██║██╔════╝████╗  ██║") +
      chalk.hex("#663fe0")("██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝╚██╗ ██╔╝"),
    chalk.white("██║   ██║██║ █╗ ██║█████╗  ██╔██╗ ██║") +
      chalk.hex("#663fe0")("██████╔╝██████╔╝██║   ██║ ╚███╔╝  ╚████╔╝ "),
    chalk.white("██║▄▄ ██║██║███╗██║██╔══╝  ██║╚██╗██║") +
      chalk.hex("#663fe0")("██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗   ╚██╔╝  "),
    chalk.white("╚██████╔╝╚███╔███╔╝███████╗██║ ╚████║") +
      chalk.hex("#663fe0")("██║     ██║  ██║╚██████╔╝██╔╝ ██╗   ██║   "),
    chalk.white(" ╚══▀▀═╝  ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝") +
      chalk.hex("#663fe0")("╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   "),
  ].join("\n");

  const info = [
    "",
    `${chalk.gray("Version:")}   ${chalk.white(version)}`,
    `${chalk.gray("Port:")}      ${chalk.white(String(opts.port))}`,
    `${chalk.gray("Browser:")}   ${chalk.white(opts.browser)}`,
    `${chalk.gray("Dashboard:")} ${chalk.underline.blue(dashboardUrl)}`,
    `${chalk.gray("Accounts:")}  ${chalk.white(String(opts.accountCount))}`,
    "",
  ].join("\n");

  return logo + "\n" + info;
}
