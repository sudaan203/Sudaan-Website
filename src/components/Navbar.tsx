"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { navLinks } from "@/lib/site";
import Logo from "./Logo";

export default function Navbar() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-ink/10 bg-abyss/80 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <nav className="container-px flex h-20 items-center justify-between">
        <Logo />

        <div className="hidden items-center gap-1 lg:flex">
          {navLinks.map((link) => {
            const active =
              link.href === "/"
                ? pathname === "/"
                : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`relative rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "text-ink-900"
                    : "text-ink/80 hover:text-ink-900"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 -z-10 rounded-full bg-ink/10"
                    transition={{ type: "spring", stiffness: 400, damping: 32 }}
                  />
                )}
                {link.label}
              </Link>
            );
          })}
        </div>

        <div className="hidden lg:block">
          <Link href="/contact" className="btn-primary">
            Request Consultation
          </Link>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-ink/10 text-ink-900 lg:hidden"
          aria-label="Toggle menu"
          aria-expanded={open}
        >
          <span className="relative flex h-4 w-5 flex-col justify-between">
            <span
              className={`h-0.5 w-full bg-current transition-transform ${
                open ? "translate-y-[7px] rotate-45" : ""
              }`}
            />
            <span
              className={`h-0.5 w-full bg-current transition-opacity ${
                open ? "opacity-0" : ""
              }`}
            />
            <span
              className={`h-0.5 w-full bg-current transition-transform ${
                open ? "-translate-y-[7px] -rotate-45" : ""
              }`}
            />
          </span>
        </button>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden border-t border-ink/10 bg-abyss/95 backdrop-blur-xl lg:hidden"
          >
            <div className="container-px flex flex-col gap-1 py-4">
              {navLinks.map((link) => {
                const active =
                  link.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`rounded-lg px-4 py-3 text-sm font-medium ${
                      active
                        ? "bg-ink/10 text-ink-900"
                        : "text-ink/80 hover:bg-ink/[0.04] hover:text-ink-900"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
              <Link href="/contact" className="btn-primary mt-2 w-full">
                Request Consultation
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
