"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Eye, EyeOff, Mail, Lock, ShieldCheck } from "lucide-react";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error || "Something went wrong");
    } else {
      router.push("/login");
    }
  }

  return (
    <div className="min-h-screen flex bg-white">
      {/* Left hero panel */}
      <div className="hidden lg:flex lg:w-1/2 bg-gray-950 relative flex-col justify-center px-16">
        <div className="max-w-md mx-auto">
          <div className="flex items-center gap-3 mb-12">
            <div className="h-10 w-10 rounded-full bg-violet-600 flex items-center justify-center">
              <ShieldCheck className="h-5 w-5 text-white" />
            </div>
            <span className="text-xl font-bold text-white">Harborlight</span>
          </div>

          <h1 className="text-4xl font-bold text-white leading-tight mb-6">
            Understand your policy with confidence.
          </h1>

          <p className="text-gray-400 leading-relaxed mb-4">
            Ask questions about your homeowners policy and get instant answers
            grounded in your actual policy document.
          </p>
          <p className="text-gray-400 leading-relaxed">
            No more digging through pages of fine print for coverage limits
            and exclusions.
          </p>

          <div className="border-t border-gray-800 mt-12 pt-6">
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">
              In the moment
            </p>
            <p className="text-lg font-semibold text-white">
              Chat with your policy, instantly.
            </p>
          </div>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-gray-900">Create account</h2>
            <p className="text-sm text-gray-500 mt-1">
              Sign up to get started with Harborlight.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <Label htmlFor="email" className="text-gray-700 text-sm font-medium">
                Email
              </Label>
              <div className="relative mt-1.5">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  className="pl-9 rounded-lg bg-blue-50/60 border-blue-100 text-gray-900 placeholder:text-gray-400 focus-visible:ring-violet-500"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="password" className="text-gray-700 text-sm font-medium">
                Password
              </Label>
              <div className="relative mt-1.5">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="pl-9 pr-9 rounded-lg bg-blue-50/60 border-blue-100 text-gray-900 placeholder:text-gray-400 focus-visible:ring-violet-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-gray-900 hover:bg-gray-800 text-white rounded-lg mt-1 py-5"
            >
              {loading ? "Creating account..." : "Create account"}
            </Button>

            <p className="text-sm text-center text-gray-500 mt-1">
              Already have an account?{" "}
              <a href="/login" className="text-violet-600 font-medium hover:underline">
                Sign in
              </a>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
