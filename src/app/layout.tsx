import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NEXUS PCB — Conception autonome par agents IA",
  description:
    "Plateforme de conception de circuits imprimés autonome : agent LLM pour l'intention, agent RL à modèle du monde pour le placement, routeur A* multicouche, simulation thermique, DRC/DFM et export Gerber RS-274X.",
  keywords: ["PCB", "IA", "agents", "placement", "routage", "Gerber", "World Model", "recuit simulé"],
  authors: [{ name: "NEXUS PCB" }],
  openGraph: {
    title: "NEXUS PCB — Conception autonome par agents IA",
    description: "De la netlist aux fichiers de fabrication, sans intervention humaine.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
