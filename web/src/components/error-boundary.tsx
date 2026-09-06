import React from "react"
import i18next from "i18next"
import { AlertTriangle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <Card className="mx-auto max-w-md">
          <CardHeader className="items-center text-center">
            <AlertTriangle className="mb-2 h-10 w-10 text-destructive" />
            <CardTitle>{i18next.t('errorBoundary.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message}
            </p>
            <Button onClick={this.handleReset}>{i18next.t('errorBoundary.tryAgain')}</Button>
          </CardContent>
        </Card>
      )
    }

    return this.props.children
  }
}
